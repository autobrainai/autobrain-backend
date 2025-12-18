// ------------------------------------------------------
// SAFETY ENGINE — Contextual warnings (Layer 2)
// ------------------------------------------------------


export const SAFETY_WARNINGS = [
{
    id: "spark_fire",
    triggers: [/spark/i, /coil/i, /ignition/i, /spark tester/i],
    warning:
      "⚠️ Safety: Confirm no raw fuel/vapor is present before checking spark. Ignition can cause fire."
  },
  {
    id: "starting_fluid",
    triggers: [/starting fluid/i, /ether/i, /brake clean/i],
    warning:
      "⚠️ Safety: Use starting fluid cautiously. Avoid on diesels with glow plugs/intake heaters. Keep face/hands clear of intake."
  },
  {
    id: "fuel_pressure",
    triggers: [/fuel pressure/i, /open.*fuel/i, /disconnect.*fuel/i, /fuel line/i],
    warning:
      "⚠️ Safety: Relieve fuel pressure before opening lines. Use eye protection; fuel spray can ignite."
  },
  {
    id: "gdi_high_pressure",
    triggers: [/direct injection/i, /\bgdi\b/i, /high pressure fuel/i, /rail pressure/i],
    warning:
      "⚠️ Safety: GDI fuel systems are extremely high pressure. Follow OEM depressurization procedure—injury risk."
  },
  {
    id: "cooling_hot_pressure",
    triggers: [/radiator cap/i, /open.*coolant/i, /pressure test/i, /cooling system/i],
    warning:
      "⚠️ Safety: Do NOT open or pressure-test the cooling system hot. Let it fully cool—scalding risk."
  },
  {
    id: "fan_belts",
    triggers: [/fan/i, /belt/i, /pulleys/i, /engine running/i],
    warning:
      "⚠️ Safety: Keep hands/tools clear of belts/fans/pulleys with engine running. Secure loose clothing."
  },
  {
    id: "srs_airbag",
    triggers: [/\bsrs\b/i, /airbag/i, /clock spring/i],
    warning:
      "⚠️ Safety: Do NOT probe SRS/airbag circuits with a meter/test light. Use scan-tool procedures only."
  },
  {
    id: "hybrid_ev_hv",
    triggers: [/hybrid/i, /\bev\b/i, /high voltage/i, /orange cable/i],
    warning:
      "⚠️ Safety: High voltage can be lethal. Do not touch/probe orange HV cables without PPE + disable + verify zero volts."
  }
];


// ------------------------------------------------------
// SAFETY ENGINE — Hard stops (Layer 3)
// ------------------------------------------------------


export const SAFETY_HARD_STOPS = [
  {
    id: "probe_srs",
    match: /(probe|test).*(airbag|srs|clock spring)|test light.*(airbag|srs)/i,
    reply:
      "Stop. Do NOT probe SRS/airbag circuits with a meter or test light — deployment risk. Use scan-tool SRS diagnostics only."
  },
  {
    id: "open_cooling_hot",
    match: /(open|remove).*(radiator cap|coolant cap)|pressure test.*(hot|warm)/i,
    reply:
      "Stop. Do NOT open or pressure-test a hot cooling system. Let it fully cool first — scalding/pressure release risk."
  },
  {
    id: "jump_random_power",
    match: /(jump|bypass).*(relay|fuse)|short.*(terminals|pins)/i,
    reply:
      "Stop. Don’t jump/short circuits blindly — you can damage modules or cause injury. Use a DVOM/scan-tool test method instead."
  },
  {
    id: "hv_orange",
    match: /(touch|probe|test).*(orange cable|high voltage)|pull.*(hybrid|ev).*(connector|cable)/i,
    reply:
      "Stop. High voltage can be lethal. Do not touch/probe orange HV cables without PPE, disable procedure, and verified zero volts."
  }
];

export function checkSafetyHardStop(msg) {
  for (const rule of SAFETY_HARD_STOPS) {
    if (rule.match.test(msg)) return rule.reply;
  }
  return null;
}

export function collectSafetyWarnings(blocks = []) {
  const text = blocks.filter(Boolean).join(" ").toLowerCase();
  const warnings = [];

  for (const rule of SAFETY_WARNINGS) {
    if (rule.triggers.some((rx) => rx.test(text))) {
      warnings.push(rule.warning);
    }
  }

  return [...new Set(warnings)];
}





