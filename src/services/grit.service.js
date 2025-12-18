import { getOpenAI } from "./openai.service.js";
import { supabase } from "./supabase.service.js"; // kept (may be used elsewhere later)
import { GRIT_RULESET } from "../rules/grit.ruleset.js";

import {
  mergeVehicleContexts,
  inferEngineStringFromYMM
} from "../utils/vehicle.util.js";

import {
  checkSafetyHardStop,
  collectSafetyWarnings
} from "../utils/safety.util.js";

import { diagnosticState } from "../state/diagnostic.state.js";

/* ======================================================
   DIAGNOSTIC STEP MAP (MVP v1) - keep
====================================================== */
const DIAGNOSTIC_STEPS = {
  awaiting_test_result: {
    pass: "next_logical_test",
    fail: "failure_path_analysis"
  },
  fuel_pressure_koeo: {
    pass: "fuel_trim_analysis",
    fail: "fuel_supply_diagnostics"
  }
};

/* ======================================================
   DOMAIN "NEXT TEST" TEMPLATES (MASTER TECH OPENERS)
   Only first 2–4 moves per domain — no OEM manuals
====================================================== */
const DOMAIN_NEXT_TEST_TEMPLATES = {
  engine_drivability: [
    {
      key: "ignition_check",
      prompt:
        "Before going deeper — have you swapped the ignition coil and/or spark plug to see if the misfire follows? (yes/no)"
    },
    {
      key: "fuel_check",
      prompt:
        "Next: Do you have injector balance or contribution data showing a weak cylinder / imbalance? (yes/no)"
    },
    {
      key: "mechanical_check",
      prompt:
        "Last basic check: Have compression or leak-down been verified on the affected cylinder(s)? (yes/no)"
    }
  ],

  starting_charging: [
    {
      key: "battery_rest",
      prompt:
        "First: What is battery voltage with the vehicle OFF? (numeric value preferred)"
    },
    {
      key: "cranking_drop",
      prompt:
        "During cranking, does battery voltage stay above ~9.6V? (yes/no)"
    },
    {
      key: "commanded_vs_actual",
      prompt:
        "If charging-related: Do you have alternator commanded vs actual voltage (or generator command/feedback) data? (yes/no)"
    }
  ],

  cooling: [
    {
      key: "coolant_level",
      prompt:
        "Basic check: Is coolant FULL and properly bled (no air pockets)? (yes/no)"
    },
    {
      key: "fan_command",
      prompt:
        "With a scan tool, do BOTH cooling fans command ON when expected? (yes/no)"
    },
    {
      key: "flow_check",
      prompt:
        "Any signs of restricted flow (collapsed hose, cold radiator spots, no heater output)? (yes/no)"
    }
  ],

  evap: [
    {
      key: "cap_and_lines",
      prompt:
        "EVAP basics: gas cap seal/tightness confirmed and visible purge/vent lines intact? (yes/no)"
    },
    {
      key: "purge_seal",
      prompt:
        "With purge commanded OFF at idle, is there any vacuum at the purge line? (yes/no)"
    },
    {
      key: "smoke_test",
      prompt:
        "Do you have access to a smoke machine to confirm the leak point? (yes/no)"
    }
  ],

  network: [
    {
      key: "power_ground",
      prompt:
        "Before chasing modules: Have power and grounds been verified at the affected module(s)? (yes/no)"
    },
    {
      key: "termination",
      prompt:
        "Next: Have you measured CAN termination resistance (~60Ω total)? (yes/no)"
    },
    {
      key: "bus_activity",
      prompt:
        "Do you see normal CAN bus voltage activity (~2.5V bias with data swing)? (yes/no)"
    }
  ],

  brakes_abs: [
    {
      key: "mechanical_basics",
      prompt:
        "Quick check: Pads, rotors, fluid level, and obvious leaks verified OK? (yes/no)"
    },
    {
      key: "wheel_speed",
      prompt:
        "In live data, does one wheel speed sensor drop out or read differently vs others? (yes/no)"
    },
    {
      key: "calibration",
      prompt:
        "Has steering angle / yaw calibration been performed or verified? (yes/no)"
    }
  ],

  transmission: [
    {
      key: "fluid_check",
      prompt:
        "First: Is transmission fluid level and condition verified correct? (yes/no)"
    },
    {
      key: "ratio_check",
      prompt:
        "Do input vs output speed sensors match expected gear ratios for the commanded gear? (yes/no)"
    },
    {
      key: "command_vs_actual",
      prompt:
        "Do commanded gear/pressure values match actual behavior (no obvious slip/flare)? (yes/no)"
    }
  ],

  hvac: [
    {
      key: "blower_operation",
      prompt:
        "Basic check: Does the blower motor operate at all speeds? (yes/no)"
    },
    {
      key: "temp_door",
      prompt:
        "Can you command blend/mode doors and see position change? (yes/no)"
    },
    {
      key: "pressure_check",
      prompt:
        "If A/C related: Are high and low side pressures plausible (not obviously flat/overcharged)? (yes/no)"
    }
  ],

  diesel_emissions: [
    {
      key: "def_quality",
      prompt:
        "First: Is DEF quality and level confirmed good (no contamination)? (yes/no)"
    },
    {
      key: "soot_load",
      prompt:
        "What is reported DPF soot/load percentage? (numeric if known)"
    },
    {
      key: "commanded_regen",
      prompt:
        "Can a forced regen be commanded, and does it complete? (yes/no)"
    }
  ],

  steering_suspension: [
    {
      key: "mechanical_play",
      prompt:
        "Initial check: Any free play in track bar, tie rods, ball joints, or steering gear? (yes/no)"
    },
    {
      key: "alignment",
      prompt:
        "Has alignment (caster especially) been measured or adjusted? (yes/no)"
    },
    {
      key: "load_test",
      prompt:
        "Does the issue change under braking or throttle load? (yes/no)"
    }
  ],

  hybrid_ev: [
    {
      key: "hv_codes",
      prompt:
        "First: Any high-voltage or isolation fault codes present? (yes/no)"
    },
    {
      key: "interlock",
      prompt:
        "Have HV interlock circuits and service disconnect been verified? (yes/no)"
    },
    {
      key: "cooling",
      prompt:
        "Are HV battery and inverter cooling systems operating normally? (yes/no)"
    }
  ],

  body_electrical: [
    {
      key: "fuse_check",
      prompt:
        "Quick check: Relevant fuses and relays verified good? (yes/no)"
    },
    {
      key: "load_test",
      prompt:
        "Has the circuit been load-tested (under demand) rather than just voltage-checked? (yes/no)"
    },
    {
      key: "ground_check",
      prompt:
        "Are grounds for the affected circuit/module verified clean and tight (preferably voltage-drop tested)? (yes/no)"
    }
  ],

  srs_airbag: [
    {
      key: "recent_work",
      prompt:
        "Safety first: Any recent interior/steering wheel/column work performed? (yes/no)"
    },
    {
      key: "clock_spring",
      prompt:
        "Have clock spring / steering angle sensor circuits been checked? (yes/no)"
    }
  ],

  tpms: [
    {
      key: "sensor_id",
      prompt:
        "Are all TPMS sensors learned and reporting pressure? (yes/no)"
    },
    {
      key: "frequency",
      prompt:
        "Do sensor frequencies match the vehicle’s system (315/433 MHz)? (yes/no)"
    }
  ],

  adas: [
    {
      key: "calibration_required",
      prompt:
        "Was calibration required due to glass, alignment, or collision work? (yes/no)"
    },
    {
      key: "camera_radar_view",
      prompt:
        "Are cameras/radar unobstructed and reporting plausibly? (yes/no)"
    }
  ]
};

/* ======================================================
   OEM OVERLAY FRAMEWORK (PHASE 1)
   - Not manuals
   - High-leverage diagnostic bias prompts
   - Applies to most U.S. fleet makes
====================================================== */

/** Normalize make so overlays work even if extraction varies */
function normalizeMake(make) {
  const m = String(make || "").trim().toLowerCase();
  if (!m) return "";
  // Common alias cleanup
  if (m === "chevy") return "chevrolet";
  if (m === "vw") return "volkswagen";
  return m;
}

function isGM(makeNorm) {
  return ["chevrolet", "gmc", "cadillac", "buick"].includes(makeNorm);
}
function isFord(makeNorm) {
  return ["ford", "lincoln"].includes(makeNorm);
}
function isStellantis(makeNorm) {
  return ["ram", "jeep", "dodge", "chrysler"].includes(makeNorm);
}
function isToyota(makeNorm) {
  return ["toyota", "lexus"].includes(makeNorm);
}
function isHonda(makeNorm) {
  return ["honda", "acura"].includes(makeNorm);
}

/**
 * Overlay shape:
 * {
 *   name: "GM",
 *   applies(vehicle) => boolean,
 *   rules: {
 *     [domainKey]: [
 *       { id, insertBeforeKey, when(ctx)=>boolean, prompt, noteOnly? }
 *     ]
 *   }
 * }
 */
const OEM_OVERLAYS = [
  // ---------------- GM ----------------
  {
    name: "GM",
    applies: (vehicle) => isGM(normalizeMake(vehicle?.make)),
    rules: {
      engine_drivability: [
        {
          id: "gm_afm_lifter_bias",
          insertBeforeKey: "mechanical_check",
          when: ({ vehicle, facts }) => {
            const eng = String(vehicle?.engine || "").toLowerCase();
            const mentionsMisfire =
              !!facts?.misfire || (facts?.dtcs || []).some((c) => /^P030[0-8]$/i.test(c));
            const looksLikeV8 =
              /5\.3|6\.2|6\.0|v8/.test(eng);
            return mentionsMisfire && looksLikeV8;
          },
          prompt:
            "GM V8 note: AFM/DOD lifter collapse is a common misfire cause. Before condemning the engine, disable AFM (if possible) / verify valvetrain/lifter behavior on the affected bank. (acknowledged? yes/no)"
        }
      ],
      starting_charging: [
        {
          id: "gm_smart_charge_bias",
          insertBeforeKey: "commanded_vs_actual",
          when: () => true,
          prompt:
            "GM charging note: Many systems are ECM-controlled. Don’t condemn the alternator off static voltage alone — verify commanded vs actual generator output / duty cycle. (acknowledged? yes/no)"
        }
      ],
      transmission: [
        {
          id: "gm_adaptive_bias",
          insertBeforeKey: "command_vs_actual",
          when: () => true,
          prompt:
            "GM trans note: After repairs, adaptives/relearns can heavily affect shift feel. Before hard conclusions, confirm adaptives status and whether a relearn is required. (acknowledged? yes/no)"
        }
      ]
    }
  },

  // ---------------- Ford / Lincoln ----------------
  {
    name: "FORD",
    applies: (vehicle) => isFord(normalizeMake(vehicle?.make)),
    rules: {
      starting_charging: [
        {
          id: "ford_smart_charging_gencom",
          insertBeforeKey: "commanded_vs_actual",
          when: () => true,
          prompt:
            "Ford smart charging note: Use scan data (generator command/feedback PIDs like GENCOM/GENMON equivalents). Static voltage tests alone can mislead. (acknowledged? yes/no)"
        }
      ],
      engine_drivability: [
        {
          id: "ford_ecoboost_smoke_test",
          insertBeforeKey: "fuel_check",
          when: ({ vehicle, facts }) => {
            const eng = String(vehicle?.engine || "").toLowerCase();
            const mentionsLean =
              !!facts?.lean || (facts?.dtcs || []).some((c) => /^P017[14]$/i.test(c));
            const ecoboost =
              /ecoboost|turbo|2\.7|3\.5|2\.0|1\.5/.test(eng);
            return mentionsLean && ecoboost;
          },
          prompt:
            "Ford EcoBoost note: Charge-air/intake leaks are common and can mimic fueling/ignition issues. Smoke test intake/charge pipes BEFORE condemning injectors/coils. (acknowledged? yes/no)"
        }
      ],
      cooling: [
        {
          id: "ford_mapped_cooling_bias",
          insertBeforeKey: "fan_command",
          when: () => true,
          prompt:
            "Ford cooling note: Many systems use mapped thermostats / electronically controlled cooling. Verify commanded vs actual temp control with scan PIDs if available. (acknowledged? yes/no)"
        }
      ]
    }
  },

  // ---------------- Stellantis (Ram/Jeep/Dodge/Chrysler) ----------------
  {
    name: "STELLANTIS",
    applies: (vehicle) => isStellantis(normalizeMake(vehicle?.make)),
    rules: {
      steering_suspension: [
        {
          id: "stellantis_death_wobble_bias",
          insertBeforeKey: "alignment",
          when: ({ facts }) => {
            const m = String(facts?.rawMessage || "").toLowerCase();
            return /(death wobble|wobble|track bar)/.test(m);
          },
          prompt:
            "Stellantis/Jeep wobble note: Track bar mounting holes, bushings, and steering linkage play must be ruled out BEFORE alignment talk. Confirm mechanical tightness first. (acknowledged? yes/no)"
        }
      ],
      body_electrical: [
        {
          id: "stellantis_power_distribution_bias",
          insertBeforeKey: "load_test",
          when: () => true,
          prompt:
            "Stellantis electrical note: Power distribution/grounds issues can cause multi-symptom weirdness. Verify power feeds/grounds under load BEFORE module condemnation. (acknowledged? yes/no)"
        }
      ],
      transmission: [
        {
          id: "stellantis_relearn_bias",
          insertBeforeKey: "command_vs_actual",
          when: () => true,
          prompt:
            "Stellantis trans note: Many drivability/shift complaints persist without the correct relearn/reset routine after repair. Confirm whether a relearn/adaptive reset applies. (acknowledged? yes/no)"
        }
      ]
    }
  },

  // ---------------- Toyota / Lexus ----------------
  {
    name: "TOYOTA",
    applies: (vehicle) => isToyota(normalizeMake(vehicle?.make)),
    rules: {
      engine_drivability: [
        {
          id: "toyota_vac_leak_bias",
          insertBeforeKey: "fuel_check",
          when: ({ facts }) => {
            const mentionsLean =
              !!facts?.lean || (facts?.dtcs || []).some((c) => /^P017[14]$/i.test(c));
            return mentionsLean;
          },
          prompt:
            "Toyota/Lexus note: Vacuum leaks and unmetered air can dominate lean + drivability complaints. Smoke test intake/PCV paths BEFORE condemning fuel delivery. (acknowledged? yes/no)"
        }
      ],
      cooling: [
        {
          id: "toyota_electric_pump_bias",
          insertBeforeKey: "flow_check",
          when: () => true,
          prompt:
            "Toyota/Lexus cooling note: Some systems use electric pumps / complex coolant routing. Verify pump operation and coolant flow with scan data/physical checks before assuming head gasket. (acknowledged? yes/no)"
        }
      ],
      transmission: [
        {
          id: "toyota_adaptive_bias",
          insertBeforeKey: "command_vs_actual",
          when: () => true,
          prompt:
            "Toyota/Lexus trans note: Shift quality can be heavily influenced by adaptives and fluid condition. Confirm correct fluid spec/level and consider adaptive reset if appropriate. (acknowledged? yes/no)"
        }
      ]
    }
  },

  // ---------------- Honda / Acura ----------------
  {
    name: "HONDA",
    applies: (vehicle) => isHonda(normalizeMake(vehicle?.make)),
    rules: {
      engine_drivability: [
        {
          id: "honda_vac_leak_bias",
          insertBeforeKey: "fuel_check",
          when: ({ facts }) => {
            const mentionsLean =
              !!facts?.lean || (facts?.dtcs || []).some((c) => /^P017[14]$/i.test(c));
            return mentionsLean;
          },
          prompt:
            "Honda/Acura note: Unmetered air (intake/vacuum/PCV) commonly drives lean + idle issues. Smoke test intake tract BEFORE chasing injectors. (acknowledged? yes/no)"
        }
      ],
      starting_charging: [
        {
          id: "honda_battery_ground_bias",
          insertBeforeKey: "cranking_drop",
          when: () => true,
          prompt:
            "Honda/Acura starting note: Don’t skip voltage-drop on grounds/B+ under load. Many ‘bad starter/alternator’ calls are actually cable/ground issues. (acknowledged? yes/no)"
        }
      ],
      cooling: [
        {
          id: "honda_bleed_bias",
          insertBeforeKey: "fan_command",
          when: () => true,
          prompt:
            "Honda/Acura cooling note: Air pockets/bleeding issues can cause false overheat symptoms after service. Confirm proper bleed procedure/flow before deeper conclusions. (acknowledged? yes/no)"
        }
      ]
    }
  }
];

/* ======================================================
   STATE HARDENING (adds missing fields safely)
====================================================== */
function ensureStateShape() {
  if (!diagnosticState) throw new Error("diagnosticState missing");

  if (!diagnosticState.mode) diagnosticState.mode = "idle";
  if (!diagnosticState.lastStep) diagnosticState.lastStep = null;
  if (diagnosticState.awaitingResponse === undefined)
    diagnosticState.awaitingResponse = false;
  if (diagnosticState.disclaimerSent === undefined)
    diagnosticState.disclaimerSent = false;

  if (!diagnosticState.domain) diagnosticState.domain = null;

  if (!diagnosticState.classification) diagnosticState.classification = {};
  if (diagnosticState.classification.misfire === undefined)
    diagnosticState.classification.misfire = null;
  if (diagnosticState.classification.lean === undefined)
    diagnosticState.classification.lean = null;
  if (diagnosticState.classification.evap === undefined)
    diagnosticState.classification.evap = null;
  if (diagnosticState.classification.network === undefined)
    diagnosticState.classification.network = null;
  if (diagnosticState.classification.charging === undefined)
    diagnosticState.classification.charging = null;
  if (diagnosticState.classification.cooling === undefined)
    diagnosticState.classification.cooling = null;
  if (diagnosticState.classification.brakes_abs === undefined)
    diagnosticState.classification.brakes_abs = null;
  if (diagnosticState.classification.transmission === undefined)
    diagnosticState.classification.transmission = null;
  if (diagnosticState.classification.hvac === undefined)
    diagnosticState.classification.hvac = null;
  if (diagnosticState.classification.diesel_emissions === undefined)
    diagnosticState.classification.diesel_emissions = null;
  if (diagnosticState.classification.steering_suspension === undefined)
    diagnosticState.classification.steering_suspension = null;
  if (diagnosticState.classification.hybrid_ev === undefined)
    diagnosticState.classification.hybrid_ev = null;
  if (diagnosticState.classification.body_electrical === undefined)
    diagnosticState.classification.body_electrical = null;
  if (diagnosticState.classification.srs === undefined)
    diagnosticState.classification.srs = null;
  if (diagnosticState.classification.tpms === undefined)
    diagnosticState.classification.tpms = null;
  if (diagnosticState.classification.adas === undefined)
    diagnosticState.classification.adas = null;

  if (!diagnosticState.expectedInput) diagnosticState.expectedInput = null; // { type, domain, meta }
  if (!diagnosticState.lastQuestionKey) diagnosticState.lastQuestionKey = null;
  if (!diagnosticState.lockedFacts) diagnosticState.lockedFacts = {}; // extra explicit lock channel

  // Added safely:
  if (diagnosticState.templateStep === undefined) diagnosticState.templateStep = 0;
}

/* ======================================================
   ANTI-REPEAT GUARD
====================================================== */
function hasRecentlyAsked(questionKey) {
  return diagnosticState.lastQuestionKey === questionKey;
}
function markAsked(questionKey) {
  diagnosticState.lastQuestionKey = questionKey;
}

/* ======================================================
   EXPECTED INPUT ENGINE
====================================================== */
function expectInput(type, domain, meta = {}) {
  diagnosticState.expectedInput = { type, domain, meta };
  diagnosticState.awaitingResponse = true;
}
function clearExpectedInput() {
  diagnosticState.expectedInput = null;
  diagnosticState.awaitingResponse = false;
}

/* ======================================================
   TEXT PARSERS (global, domain-agnostic)
====================================================== */
function normalize(msg = "") {
  return String(msg || "").trim();
}

function parseYesNo(message) {
  const m = normalize(message).toLowerCase();
  if (/(^|\b)(yes|yep|yeah|done|checked|verified|confirmed|ok)(\b|$)/i.test(m))
    return "yes";
  if (
    /(^|\b)(no|nope|nah|not yet|not done|didn't|did not|havent|haven't|idk)(\b|$)/i.test(m)
  )
    return "no";
  return null;
}

function parseOccurrence(message) {
  const m = normalize(message).toLowerCase();
  if (/\bidle\b/.test(m)) return "idle";
  if (/\b(cruise|steady|steady speed)\b/.test(m)) return "cruise";
  if (/\b(load|under load|accel|acceleration|driving|on throttle|wot)\b/.test(m))
    return "under_load";
  if (/\b(cold|cold start|startup|first start)\b/.test(m)) return "cold_start";
  if (/\b(hot|heat soaked|after warm|warm)\b/.test(m)) return "hot";
  if (/\b(all the time|always|constant)\b/.test(m)) return "all_the_time";
  return null;
}

function parseScopeSingleMultiple(message) {
  const m = normalize(message).toLowerCase();
  if (/\b(single|one module|only one)\b/.test(m)) return "single";
  if (/\b(multiple|many|several|all modules|more than one)\b/.test(m))
    return "multiple";
  return null;
}

function parseTempBand(message) {
  const m = normalize(message).toLowerCase();
  if (/\bidle\b/.test(m)) return "idle";
  if (/\bdriving\b/.test(m)) return "driving";
  if (/\bhighway|load|hill|towing\b/.test(m)) return "highway_load";
  if (/\bimmediately|right away|quickly\b/.test(m)) return "immediate";
  if (/\bgauge only|no boil|no coolant loss\b/.test(m)) return "gauge_only";
  return null;
}

function parseNoStartType(message) {
  const m = normalize(message).toLowerCase();
  if (/\b(no crank|doesn't crank|starter)\b/.test(m)) return "no_crank";
  if (/\b(cranks|turns over)\b/.test(m)) return "crank_no_start";
  return null;
}

function parseBrakeComplaint(message) {
  const m = normalize(message).toLowerCase();
  if (/\b(abs|traction|stabilitrak|esc)\b/.test(m)) return "abs_light";
  if (/\bsoft\b/.test(m)) return "soft_pedal";
  if (/\bhard\b/.test(m)) return "hard_pedal";
  if (/\bpull\b/.test(m)) return "pull";
  if (/\bnoise|grind|squeal\b/.test(m)) return "noise";
  return null;
}

function parseTransComplaint(message) {
  const m = normalize(message).toLowerCase();
  if (/\bno movement|won't move\b/.test(m)) return "no_movement";
  if (/\bslip|slipping\b/.test(m)) return "slip";
  if (/\bharsh|bang\b/.test(m)) return "harsh_shift";
  if (/\bdelayed\b/.test(m)) return "delayed_engagement";
  return null;
}

/* ======================================================
   PASS/FAIL CLASSIFIER (ONLY for test steps GRIT asked)
====================================================== */
function classifyTechResponse(message) {
  const m = normalize(message).toLowerCase();

  if (
    /(^|\b)(pass|passed|good|ok|okay|normal|yes|done|checked|tested|verified|confirmed)(\b|$)/i.test(
      m
    )
  )
    return "pass";

  if (
    /(^|\b)(fail|failed|bad|no|nope|nah|negative|zero|not yet|not done|didn't|havent|haven't|idk|not sure)(\b|$)/i.test(
      m
    )
  )
    return "fail";

  return null;
}

/* ======================================================
   DTC EXTRACTORS (LOCK FACTS SO GRIT DOESN'T ASK DUMB Qs)
   NOTE: These are generic, not OEM-specific causes.
====================================================== */
function extractDTCs(message) {
  const m = normalize(message);
  const codes = Array.from(m.matchAll(/\b([PBUC]\d{4})\b/gi)).map((x) =>
    x[1].toUpperCase()
  );
  return [...new Set(codes)];
}

function lockMisfireFactsFromDTCs(dtcs) {
  // P0300 = random/multiple; P0301..P0308 = cylinder
  const cyl = dtcs
    .map((c) => c.match(/^P030([1-8])$/i))
    .find(Boolean);
  if (cyl) return { type: "single", cylinder: Number(cyl[1]) };
  if (dtcs.some((c) => /^P0300$/i.test(c))) return { type: "multiple" };
  return null;
}

function lockLeanFactsFromDTCs(dtcs) {
  const has171 = dtcs.some((c) => /^P0171$/i.test(c));
  const has174 = dtcs.some((c) => /^P0174$/i.test(c));
  if (has171 && has174) return { banks: "both" };
  if (has171) return { banks: "bank1" };
  if (has174) return { banks: "bank2" };
  return null;
}

function lockEvapFactsFromDTCs(dtcs, message) {
  const m = normalize(message).toLowerCase();
  if (dtcs.some((c) => /^P0455$/i.test(c)) || /large leak/.test(m))
    return { type: "large_leak" };
  if (dtcs.some((c) => /^P0456$/i.test(c)) || /small leak/.test(m))
    return { type: "small_leak" };
  if (dtcs.some((c) => /^P044[3-9]$/i.test(c)) || /(purge|vent)/.test(m))
    return { type: "purge_vent_performance" };
  return null;
}

function lockNetworkFactsFromDTCs(dtcs) {
  // U**** = network domain
  const u = dtcs.filter((c) => /^U\d{4}$/i.test(c));
  if (u.length) return { u_codes: u };
  return null;
}

function lockChargingFactsFromDTCs(dtcs, message) {
  const m = normalize(message).toLowerCase();
  // Generic charging-ish hints
  if (/battery light|charging system|alternator|overcharging|no charge/.test(m))
    return { hint: "charging" };
  // Some makes use P0562/P0563 for system voltage low/high (generic)
  if (dtcs.some((c) => /^P0562$/i.test(c))) return { voltage: "low" };
  if (dtcs.some((c) => /^P0563$/i.test(c))) return { voltage: "high" };
  return null;
}

function lockCoolingFactsFromText(message) {
  const m = normalize(message).toLowerCase();
  if (!/(overheat|overheating|running hot|temp gauge|coolant temp)/.test(m))
    return null;
  return { complaint: "overheat" };
}

function lockBrakesAbsFactsFromText(message) {
  const m = normalize(message).toLowerCase();
  if (!/(abs|traction|stabilitrak|esc|brake light|brakes)/.test(m)) return null;
  return { complaint: "brakes_abs" };
}

function lockTransFactsFromText(message) {
  const m = normalize(message).toLowerCase();
  if (!/(transmission|slip|slipping|harsh shift|delayed engagement|no movement)/.test(m))
    return null;
  return { complaint: "transmission" };
}

/* ======================================================
   DOMAIN DETECTION (choose the correct "mental model")
====================================================== */
const DOMAINS = {
  engine_drivability: "engine_drivability",
  starting_charging: "starting_charging",
  cooling: "cooling",
  evap: "evap",
  network: "network",
  brakes_abs: "brakes_abs",
  transmission: "transmission",
  hvac: "hvac",
  diesel_emissions: "diesel_emissions",
  steering_suspension: "steering_suspension",
  hybrid_ev: "hybrid_ev",
  body_electrical: "body_electrical",
  srs_airbag: "srs_airbag",
  tpms: "tpms",
  adas: "adas",
  unknown: "unknown"
};

function detectDomain({ message, dtcs }) {
  const m = normalize(message).toLowerCase();

  // Hard domains from codes:
  if (dtcs.some((c) => /^U\d{4}$/i.test(c))) return DOMAINS.network;
  if (dtcs.some((c) => /^C\d{4}$/i.test(c))) return DOMAINS.brakes_abs; // often chassis/ABS
  if (dtcs.some((c) => /^B\d{4}$/i.test(c))) return DOMAINS.body_electrical;

  // SRS explicit words (also safety handled elsewhere)
  if (/\b(srs|airbag|clock spring)\b/.test(m)) return DOMAINS.srs_airbag;

  // EV/Hybrid
  if (/\b(hybrid|ev|high voltage|orange cable)\b/.test(m)) return DOMAINS.hybrid_ev;

  // EVAP
  if (/(evap|p04\d{2}|purge|vent|large leak|small leak)/.test(m))
    return DOMAINS.evap;

  // Cooling
  if (/(overheat|overheating|running hot|temp gauge|coolant temp|fan not working)/.test(m))
    return DOMAINS.cooling;

  // Starting/Charging
  if (/(no crank|won't crank|clicks|battery light|alternator|no charge|starter)/.test(m))
    return DOMAINS.starting_charging;

  // Brakes/ABS
  if (/(abs|traction|stabilitrak|esc|brake light|brake pedal|soft pedal|hard pedal)/.test(m))
    return DOMAINS.brakes_abs;

  // Transmission
  if (/(transmission|slipping|harsh shift|delayed engagement|no movement)/.test(m))
    return DOMAINS.transmission;

  // HVAC
  if (/(no heat|no a\/c|ac not cold|blower|hvac|blend door)/.test(m))
    return DOMAINS.hvac;

  // Diesel emissions / aftertreatment
  if (
    /(def|scr|dpf|regen|soot|reductant|p20|p24|p26|p04db|nox|doser|egr)/.test(m)
  )
    return DOMAINS.diesel_emissions;

  // Steering/suspension
  if (/(death wobble|clunk|wander|loose steering|vibration|track bar|tie rod|ball joint)/.test(m))
    return DOMAINS.steering_suspension;

  // TPMS / ADAS
  if (/(tpms|tire pressure monitor|low tire)/.test(m)) return DOMAINS.tpms;
  if (/(adas|lane keep|adaptive cruise|front camera|radar|collision)/.test(m))
    return DOMAINS.adas;

  // Default: engine/drivability if P-codes or engine symptoms
  if (dtcs.some((c) => /^P\d{4}$/i.test(c))) return DOMAINS.engine_drivability;
  if (/(misfire|rough idle|stall|no start|runs rough|smoke|lean|rich)/.test(m))
    return DOMAINS.engine_drivability;

  return DOMAINS.unknown;
}

function setDomainIfNeeded(domain) {
  if (!diagnosticState.domain) diagnosticState.domain = domain;
  // If already set, don’t churn domains mid-flow unless explicitly changed.
}

/* ======================================================
   OEM OVERLAY RESOLUTION
====================================================== */
function getApplicableOverlays(vehicle) {
  return OEM_OVERLAYS.filter((o) => {
    try {
      return o.applies(vehicle);
    } catch {
      return false;
    }
  });
}

/**
 * Returns an overlay prompt (string) if an overlay rule should be injected
 * before a given template step key.
 */
function maybeRunOverlayBeforeStep({ vehicle, domain, insertBeforeKey, facts }) {
  const applicable = getApplicableOverlays(vehicle);
  if (!applicable.length) return null;

  for (const overlay of applicable) {
    const rules = overlay.rules?.[domain];
    if (!rules || !rules.length) continue;

    for (const r of rules) {
      if (r.insertBeforeKey !== insertBeforeKey) continue;

      const overlayQuestionKey = `overlay_${overlay.name}_${domain}_${r.id}`;
      if (hasRecentlyAsked(overlayQuestionKey)) continue;

      const ctx = { vehicle, facts };
      let ok = true;
      try {
        ok = typeof r.when === "function" ? !!r.when(ctx) : true;
      } catch {
        ok = false;
      }
      if (!ok) continue;

      // Ask overlay prompt and pause
      markAsked(overlayQuestionKey);
      expectInput("yes_no", domain, { overlay: overlay.name, id: r.id });
      return r.prompt;
    }
  }

  return null;
}

/* ======================================================
   DOMAIN TEMPLATE EXECUTOR (non-destructive)
   - Inject overlays BEFORE specific template steps
   - Then ask the template step
====================================================== */
function maybeRunDomainTemplate({ vehicle, facts }) {
  if (!diagnosticState.domain) return null;

  const template = DOMAIN_NEXT_TEST_TEMPLATES[diagnosticState.domain];
  if (!template || !template.length) return null;

  // Initialize once; safe
  if (diagnosticState.templateStep === undefined) diagnosticState.templateStep = 0;

  const step = template[diagnosticState.templateStep];
  if (!step) return null;

  // 1) Try OEM overlay BEFORE this step
  const overlayPrompt = maybeRunOverlayBeforeStep({
    vehicle,
    domain: diagnosticState.domain,
    insertBeforeKey: step.key,
    facts
  });
  if (overlayPrompt) return { reply: overlayPrompt };

  // 2) Ask template step (anti-repeat)
  if (hasRecentlyAsked(step.key)) return null;

  markAsked(step.key);
  diagnosticState.templateStep += 1;
  expectInput("yes_no", diagnosticState.domain, { templateStep: step.key });

  return { reply: step.prompt };
}

/* ======================================================
   GLOBAL CONSUME ENGINE
   If we asked a question, consume the next answer
====================================================== */
function consumeExpectedInputIfAnswered(message) {
  ensureStateShape();
  if (!diagnosticState.expectedInput) return null;

  const { type, domain } = diagnosticState.expectedInput;

  // Generic yes/no consumer (for templates + overlays)
  if (type === "yes_no") {
    const yn = parseYesNo(message);
    if (!yn) return null;

    // Lock the ack so we can reference it later if we want
    diagnosticState.lockedFacts = {
      ...(diagnosticState.lockedFacts || {}),
      last_yesno: yn,
      last_yesno_meta: diagnosticState.expectedInput?.meta || null
    };

    clearExpectedInput();
    diagnosticState.lastStep = "yesno_consumed";

    // IMPORTANT: return null so runGrit continues and can ask the next step immediately
    return null;
  }

  // MISFIRE occurrence
  if (type === "misfire_occurrence" && domain === DOMAINS.engine_drivability) {
    const occ = parseOccurrence(message);
    if (!occ) return null;

    diagnosticState.classification.misfire = {
      ...(diagnosticState.classification.misfire || {}),
      condition: occ
    };

    clearExpectedInput();
    diagnosticState.lastStep = "misfire_classified";

    const mf = diagnosticState.classification.misfire || {};
    return {
      reply:
        `Misfire confirmed (${mf.type || "unknown"}${mf.cylinder ? ` — cylinder ${mf.cylinder}` : ""}, ${mf.condition}).\n\n` +
        `First test: Swap the ignition coil with another cylinder and see if the misfire follows.\n\nDid you do that yet?`
    };
  }

  // LEAN band
  if (type === "lean_band" && domain === DOMAINS.engine_drivability) {
    const band = parseOccurrence(message); // reuse: idle/cruise/under_load etc
    if (!band) return null;

    diagnosticState.classification.lean = {
      ...(diagnosticState.classification.lean || {}),
      band
    };

    clearExpectedInput();
    diagnosticState.lastStep = "lean_classified";

    const ln = diagnosticState.classification.lean || {};
    return {
      reply:
        `Lean condition locked (${ln.banks || "unknown"}; ${ln.band}).\n\n` +
        `Next: What are STFT/LTFT at idle and at ~2500 RPM (both banks)?`
    };
  }

  // EVAP verified
  if (type === "evap_verified" && domain === DOMAINS.evap) {
    const yn = parseYesNo(message);
    if (!yn) return null;

    diagnosticState.classification.evap = {
      ...(diagnosticState.classification.evap || {}),
      basics_verified: yn === "yes"
    };

    clearExpectedInput();
    diagnosticState.lastStep = "evap_classified";

    return {
      reply:
        yn === "yes"
          ? `Good. Next: With purge commanded OFF at idle, is there ANY vacuum at the purge line? (yes/no)`
          : `Do basics first: verify gas cap seal/tightness, then inspect purge + vent lines for cracks/disconnects.\n\nDone? (yes/no)`
    };
  }

  // NETWORK scope
  if (type === "network_scope" && domain === DOMAINS.network) {
    const scope = parseScopeSingleMultiple(message);
    if (!scope) return null;

    diagnosticState.classification.network = {
      ...(diagnosticState.classification.network || {}),
      scope
    };

    clearExpectedInput();
    diagnosticState.lastStep = "network_classified";

    return {
      reply:
        `Network scope locked (${scope}).\n\n` +
        `Next: Which module is reporting the U-code(s), and do you have a network topology screenshot/list?`
    };
  }

  // OVERHEAT band
  if (type === "overheat_band" && domain === DOMAINS.cooling) {
    const band = parseTempBand(message);
    if (!band) return null;

    diagnosticState.classification.cooling = {
      ...(diagnosticState.classification.cooling || {}),
      band
    };

    clearExpectedInput();
    diagnosticState.lastStep = "cooling_classified";

    return {
      reply:
        `Overheat condition locked (${band}).\n\n` +
        `Next: Is coolant FULL and bled properly, and do BOTH radiator fans command ON with scan tool? (yes/no)`
    };
  }

  // NO-START type
  if (type === "nostart_type" && domain === DOMAINS.starting_charging) {
    const t = parseNoStartType(message);
    if (!t) return null;

    diagnosticState.classification.charging = {
      ...(diagnosticState.classification.charging || {}),
      no_start_type: t
    };

    clearExpectedInput();
    diagnosticState.lastStep = "starting_classified";

    return {
      reply:
        t === "no_crank"
          ? `No-crank locked.\n\nNext: Key ON — do you have battery voltage at the starter B+ stud? (yes/no)`
          : `Crank/no-start locked.\n\nNext: Do you have RPM signal while cranking and fuel pressure within spec? (yes/no)`
    };
  }

  // BRAKES complaint
  if (type === "brake_complaint" && domain === DOMAINS.brakes_abs) {
    const c = parseBrakeComplaint(message);
    if (!c) return null;

    diagnosticState.classification.brakes_abs = {
      ...(diagnosticState.classification.brakes_abs || {}),
      complaint: c
    };

    clearExpectedInput();
    diagnosticState.lastStep = "brakes_classified";

    return {
      reply:
        c === "abs_light"
          ? `ABS/traction complaint locked.\n\nNext: Which ABS code(s), and which wheel speed drops out in live data?`
          : `Brake complaint locked (${c}).\n\nNext: Any fluid leaks and is brake fluid level correct? (yes/no)`
    };
  }

  // TRANS complaint
  if (type === "trans_complaint" && domain === DOMAINS.transmission) {
    const c = parseTransComplaint(message);
    if (!c) return null;

    diagnosticState.classification.transmission = {
      ...(diagnosticState.classification.transmission || {}),
      complaint: c
    };

    clearExpectedInput();
    diagnosticState.lastStep = "trans_classified";

    return {
      reply:
        `Transmission complaint locked (${c}).\n\n` +
        `Next: Fluid level/condition confirmed OK and any TCM codes present? (yes/no)`
    };
  }

  return null;
}

/* ======================================================
   DOMAIN FIRST-QUESTION GATES (non-redundant)
====================================================== */
function maybeAskFirstDomainQuestion({ message, dtcs, mergedVehicle }) {
  const m = normalize(message).toLowerCase();

  // ENGINE/DRIVABILITY: Misfire
  const mf = diagnosticState.classification.misfire;
  const mentionsMisfire =
    /(misfire|misfiring|rough idle|shaking|p0300|p030[1-8])/.test(m) ||
    dtcs.some((c) => /^P030[0-8]$/i.test(c));

  if (diagnosticState.domain === DOMAINS.engine_drivability && mentionsMisfire) {
    if (mf && mf.condition) return null;

    if (!hasRecentlyAsked("misfire_occurrence")) {
      markAsked("misfire_occurrence");
      expectInput("misfire_occurrence", DOMAINS.engine_drivability);

      return {
        reply:
          `Misfire locked (${(mf && mf.type) ? mf.type : "unknown"}${(mf && mf.cylinder) ? ` — cylinder ${mf.cylinder}` : ""}).\n\n` +
          `When does it occur?\n• Idle\n• Cruise\n• Under load\n• Cold start\n• All the time`
      };
    }
  }

  // ENGINE/DRIVABILITY: Lean
  const ln = diagnosticState.classification.lean;
  const mentionsLean =
    /(lean|p0171|p0174)/.test(m) || dtcs.some((c) => /^P017[14]$/i.test(c));

  if (diagnosticState.domain === DOMAINS.engine_drivability && mentionsLean) {
    if (ln && ln.band) return null;

    if (ln && ln.banks && !hasRecentlyAsked("lean_band")) {
      markAsked("lean_band");
      expectInput("lean_band", DOMAINS.engine_drivability);
      return {
        reply:
          `Lean condition locked (${ln.banks}).\n\nWhere does it happen?\n• Idle\n• Cruise\n• Under load`
      };
    }
  }

  // COOLING: overheating band
  const cooling = diagnosticState.classification.cooling;
  const mentionsCooling = /(overheat|overheating|running hot|temp gauge|coolant temp)/.test(m);

  if (diagnosticState.domain === DOMAINS.cooling && mentionsCooling) {
    if (cooling && cooling.band) return null;

    if (!hasRecentlyAsked("overheat_band")) {
      markAsked("overheat_band");
      expectInput("overheat_band", DOMAINS.cooling);
      return {
        reply:
          `Classify the overheating condition:\n\n` +
          `1) Idle / stopped\n` +
          `2) Driving\n` +
          `3) Highway/load/towing\n` +
          `4) Pegs hot immediately after startup\n` +
          `5) Gauge reads hot but no boil-over/coolant loss\n\n` +
          `Reply in plain words (ex: "idle only").`
      };
    }
  }

  // STARTING/CHARGING: no-start/no-crank type
  const mentionsNoStart = /(no start|won't start|cranks but|no crank|clicks|starter)/.test(m);
  const ch = diagnosticState.classification.charging;

  if (diagnosticState.domain === DOMAINS.starting_charging && mentionsNoStart) {
    if (ch && ch.no_start_type) return null;

    if (!hasRecentlyAsked("nostart_type")) {
      markAsked("nostart_type");
      expectInput("nostart_type", DOMAINS.starting_charging);
      return {
        reply:
          `Before anything else, classify it:\n\n` +
          `1) CRANKS but will not start\n` +
          `2) NO-CRANK (starter does not engage)\n\n` +
          `Reply with words: "crank no-start" or "no-crank".`
      };
    }
  }

  // EVAP: basics verified
  const ev = diagnosticState.classification.evap;
  const mentionsEvap = /(evap|p04\d{2}|purge|vent|large leak|small leak)/.test(m);

  if (diagnosticState.domain === DOMAINS.evap && mentionsEvap) {
    if (ev && ev.basics_verified !== undefined) return null;

    if (!hasRecentlyAsked("evap_verified")) {
      markAsked("evap_verified");
      expectInput("evap_verified", DOMAINS.evap);
      return {
        reply:
          `EVAP fault locked (${ev?.type || "unknown"}).\n\n` +
          `Have you verified basics yet: gas cap seal/tight + visible purge/vent lines OK? (yes/no)`
      };
    }
  }

  // NETWORK: scope
  const nw = diagnosticState.classification.network;
  const mentionsNetwork = dtcs.some((c) => /^U\d{4}$/i.test(c)) || /(lost communication|can bus|network)/.test(m);

  if (diagnosticState.domain === DOMAINS.network && mentionsNetwork) {
    if (nw && nw.scope) return null;

    if (!hasRecentlyAsked("network_scope")) {
      markAsked("network_scope");
      expectInput("network_scope", DOMAINS.network);
      return {
        reply:
          `Network fault detected.\n\nIs this:\n• SINGLE module complaining\nOR\n• MULTIPLE modules offline?\n\nReply: single or multiple.`
      };
    }
  }

  // BRAKES/ABS: classify quickly
  const mentionsBrakes = /(abs|traction|stabilitrak|esc|brake light|brake pedal|soft pedal|hard pedal|pull|grind|squeal)/.test(m);
  const br = diagnosticState.classification.brakes_abs;

  if (diagnosticState.domain === DOMAINS.brakes_abs && mentionsBrakes) {
    if (br && br.complaint) return null;

    if (!hasRecentlyAsked("brake_complaint")) {
      markAsked("brake_complaint");
      expectInput("brake_complaint", DOMAINS.brakes_abs);
      return {
        reply:
          `Classify the brake complaint:\n\n` +
          `• ABS/traction light\n` +
          `• Soft pedal\n` +
          `• Hard pedal\n` +
          `• Pull\n` +
          `• Noise\n\nReply with one.`
      };
    }
  }

  // TRANSMISSION: classify quickly
  const mentionsTrans = /(transmission|slip|slipping|harsh shift|delayed engagement|no movement)/.test(m);
  const tr = diagnosticState.classification.transmission;

  if (diagnosticState.domain === DOMAINS.transmission && mentionsTrans) {
    if (tr && tr.complaint) return null;

    if (!hasRecentlyAsked("trans_complaint")) {
      markAsked("trans_complaint");
      expectInput("trans_complaint", DOMAINS.transmission);
      return {
        reply:
          `Classify the transmission symptom:\n\n` +
          `• No movement\n` +
          `• Slipping\n` +
          `• Harsh shifts\n` +
          `• Delayed engagement\n\nReply with one.`
      };
    }
  }

  return null;
}

/* ======================================================
   VEHICLE EXTRACTION (keep)
====================================================== */
async function extractVehicleFromText(message) {
  try {
    const openai = getOpenAI();
    const resp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `Extract ONLY this JSON:
{ "year": "", "make": "", "model": "", "engine": "" }
Unknown => empty string.`
        },
        { role: "user", content: message }
      ]
    });

    return JSON.parse(resp.choices[0].message.content);
  } catch {
    return { year: "", make: "", model: "", engine: "" };
  }
}

/* ======================================================
   SHORT GRIT ACK (keep)
====================================================== */
function buildGritResponse(msg, v) {
  const lower = normalize(msg).toLowerCase();
  const hasSymptoms =
    lower.includes("code") ||
    lower.includes("p0") ||
    lower.includes("misfir") ||
    lower.includes("no start") ||
    lower.includes("stall") ||
    lower.includes("noise") ||
    lower.includes("overheat");

  const short = normalize(msg).split(/\s+/).length <= 6;
  if (!short || hasSymptoms || !(v.year || v.make || v.model)) return null;

  return `
A ${v.year} ${v.make} ${v.model}. Noted.
But what's it *doing*?

Codes?
Misfires?
No-start?
Noise?
Overheating?

Give mileage + symptoms so I can build a real plan.`;
}

/* ======================================================
   LOCK FACTS (all domains)
====================================================== */
function lockFactsFromMessage({ message, dtcs }) {
  // Misfire
  const mf = lockMisfireFactsFromDTCs(dtcs);
  if (mf) {
    diagnosticState.classification.misfire = {
      ...(diagnosticState.classification.misfire || {}),
      ...mf
    };
  }

  // Lean
  const ln = lockLeanFactsFromDTCs(dtcs);
  if (ln) {
    diagnosticState.classification.lean = {
      ...(diagnosticState.classification.lean || {}),
      ...ln
    };
  }

  // EVAP
  const ev = lockEvapFactsFromDTCs(dtcs, message);
  if (ev) {
    diagnosticState.classification.evap = {
      ...(diagnosticState.classification.evap || {}),
      ...ev
    };
  }

  // Network
  const nw = lockNetworkFactsFromDTCs(dtcs);
  if (nw) {
    diagnosticState.classification.network = {
      ...(diagnosticState.classification.network || {}),
      ...nw
    };
  }

  // Charging
  const ch = lockChargingFactsFromDTCs(dtcs, message);
  if (ch) {
    diagnosticState.classification.charging = {
      ...(diagnosticState.classification.charging || {}),
      ...ch
    };
  }

  // Cooling/brakes/trans hints
  const cool = lockCoolingFactsFromText(message);
  if (cool) {
    diagnosticState.classification.cooling = {
      ...(diagnosticState.classification.cooling || {}),
      ...cool
    };
  }

  const br = lockBrakesAbsFactsFromText(message);
  if (br) {
    diagnosticState.classification.brakes_abs = {
      ...(diagnosticState.classification.brakes_abs || {}),
      ...br
    };
  }

  const tr = lockTransFactsFromText(message);
  if (tr) {
    diagnosticState.classification.transmission = {
      ...(diagnosticState.classification.transmission || {}),
      ...tr
    };
  }

  // Helpful for overlays: keep raw message accessible (non-destructive)
  diagnosticState.lockedFacts = {
    ...(diagnosticState.lockedFacts || {}),
    rawMessage: message
  };
}

/* ======================================================
   MAIN GRIT SERVICE
====================================================== */
export async function runGrit({ message, context = [], vehicleContext = {} }) {
  ensureStateShape();
  const lower = normalize(message).toLowerCase();

  /* ---------- HARD SAFETY STOP ---------- */
  const hardStop = checkSafetyHardStop(message);
  if (hardStop) {
    return {
      reply: hardStop,
      vehicle: mergeVehicleContexts(vehicleContext, {})
    };
  }

  /* ---------- GLOBAL SAFETY DISCLAIMER (once) ---------- */
  let globalSafetyDisclaimer = "";
  if (!diagnosticState.disclaimerSent) {
    diagnosticState.disclaimerSent = true;
    globalSafetyDisclaimer =
      "⚠️ Safety: AutoBrain GRIT provides diagnostic guidance for trained technicians. " +
      "Follow OEM procedures and shop safety standards.\n\n";
  }

  /* ---------- VEHICLE EXTRACTION ---------- */
  const extracted = await extractVehicleFromText(message);
  let mergedVehicle = mergeVehicleContexts(vehicleContext, extracted);
  mergedVehicle.engine = inferEngineStringFromYMM(mergedVehicle);

  /* ---------- QUICK RESPONSE (non-diagnostic) ---------- */
  if (diagnosticState.mode !== "active") {
    const quick = buildGritResponse(message, mergedVehicle);
    if (quick) return { reply: quick, vehicle: mergedVehicle };
  }

  /* ---------- ENTER DIAGNOSTIC MODE ---------- */
  const dtcs = extractDTCs(message);
 if (
  dtcs.length ||
  /\b(check engine|diagnose|misfire|rough idle|no start|stall|overheat|noise)\b/i.test(message)
) {
  diagnosticState.mode = "active";
}


  /* ---------- DOMAIN SELECTION (lock once) ---------- */
  const detectedDomain = detectDomain({ message, dtcs });
  setDomainIfNeeded(detectedDomain);

  /* ---------- LOCK FACTS (all domains) ---------- */
  lockFactsFromMessage({ message, dtcs });

  /* ======================================================
     GLOBAL CONSUME PASS (prevents redundant questions)
  ====================================================== */
  const consumed = consumeExpectedInputIfAnswered(message);
  if (consumed) {
    return { reply: consumed.reply, vehicle: mergedVehicle };
  }

  /* ======================================================
     DOMAIN FIRST QUESTION (only what we don't know yet)
  ====================================================== */
  const domainGate = maybeAskFirstDomainQuestion({
    message,
    dtcs,
    mergedVehicle
  });
  if (domainGate) {
    return { reply: domainGate.reply, vehicle: mergedVehicle };
  }

  /* ======================================================
     OEM OVERLAY + DOMAIN TEMPLATE NEXT TEST (master-tech opener)
     - overlays can inject "bias prompts"
     - then templates ask the next universal step
  ====================================================== */
  const templateOrOverlay = maybeRunDomainTemplate({
    vehicle: mergedVehicle,
    facts: {
      dtcs,
      misfire: diagnosticState.classification?.misfire || null,
      lean: diagnosticState.classification?.lean || null,
      evap: diagnosticState.classification?.evap || null,
      network: diagnosticState.classification?.network || null,
      charging: diagnosticState.classification?.charging || null,
      cooling: diagnosticState.classification?.cooling || null,
      brakes_abs: diagnosticState.classification?.brakes_abs || null,
      transmission: diagnosticState.classification?.transmission || null,
      rawMessage: diagnosticState.lockedFacts?.rawMessage || message
    }
  });
  if (templateOrOverlay) {
    return { reply: templateOrOverlay.reply, vehicle: mergedVehicle };
  }

  /* ======================================================
     HANDLE PASS/FAIL FOR TEST STEPS (if you use them)
  ====================================================== */
  if (diagnosticState.awaitingResponse && diagnosticState.lastStep) {
    const result = classifyTechResponse(message);
    if (result && DIAGNOSTIC_STEPS[diagnosticState.lastStep]) {
      diagnosticState.lastStep =
        DIAGNOSTIC_STEPS[diagnosticState.lastStep][result] || null;
      diagnosticState.awaitingResponse = false;
      diagnosticState.expectedTest = null;

      context.push({
        role: "system",
        content: "Previous diagnostic test confirmed. Continuing."
      });
    }
  }

  /* ---------- SAFETY WARNINGS (Layer 2) ---------- */
  const lastAssistant =
    context?.length ? context[context.length - 1]?.content || "" : "";

  const safetyWarnings = collectSafetyWarnings([message, lastAssistant]);

  /* ---------- AI RESPONSE ---------- */
  const openai = getOpenAI();
  const ai = await openai.chat.completions.create({
    model: "gpt-4.1",
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: `
You are GRIT — a ruthless diagnostic mentor.

${globalSafetyDisclaimer}
${safetyWarnings.length ? safetyWarnings.join("\n") + "\n\n" : ""}

ACTIVE DOMAIN (do NOT drift): ${diagnosticState.domain || "unknown"}

Locked Facts (do NOT ask for these again):
${JSON.stringify(
  {
    dtcs,
    domain: diagnosticState.domain || null,
    make: mergedVehicle?.make || null,
    model: mergedVehicle?.model || null,
    engine: mergedVehicle?.engine || null,
    misfire: diagnosticState.classification?.misfire || null,
    lean: diagnosticState.classification?.lean || null,
    evap: diagnosticState.classification?.evap || null,
    network: diagnosticState.classification?.network || null,
    charging: diagnosticState.classification?.charging || null,
    cooling: diagnosticState.classification?.cooling || null,
    brakes_abs: diagnosticState.classification?.brakes_abs || null,
    transmission: diagnosticState.classification?.transmission || null,
    hvac: diagnosticState.classification?.hvac || null,
    diesel_emissions: diagnosticState.classification?.diesel_emissions || null,
    steering_suspension: diagnosticState.classification?.steering_suspension || null,
    hybrid_ev: diagnosticState.classification?.hybrid_ev || null,
    body_electrical: diagnosticState.classification?.body_electrical || null,
    srs: diagnosticState.classification?.srs || null,
    tpms: diagnosticState.classification?.tpms || null,
    adas: diagnosticState.classification?.adas || null,
    expectedInput: diagnosticState.expectedInput || null,
    lastQuestionKey: diagnosticState.lastQuestionKey || null,
    templateStep: diagnosticState.templateStep || 0
  },
  null,
  2
)}

${GRIT_RULESET}

Vehicle Context:
${JSON.stringify(mergedVehicle)}
`
      },
      ...(context || []),
      { role: "user", content: message }
    ]
  });

  return {
    reply: ai.choices[0].message.content,
    vehicle: mergedVehicle
  };
}
