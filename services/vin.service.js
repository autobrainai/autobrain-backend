import { supabase } from "./supabase.service.js";
import { classifyGMEngine } from "../utils/engine.util.js";

export async function decodeVinWithCache(vinRaw) {
  const vin = vinRaw.trim().toUpperCase();

  const { data } = await supabase
    .from("vin_decodes")
    .select("*")
    .eq("vin", vin)
    .maybeSingle();

  if (data) {
    return {
      vin,
      year: data.year,
      make: data.make,
      model: data.model,
      engine: data.engine,
      engineDetails: data.engine_details
    };
  }

  const resp = await fetch(
    `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${vin}?format=json`
  );
  const json = await resp.json();
  const results = json.Results;

  const get = (label) => {
    const row = results.find((r) => r.Variable === label);
    return row?.Value && row.Value !== "Not Applicable" ? row.Value : "";
  };

  const year = get("Model Year");
  const make = get("Make");
  const model = get("Model");
  const engineModel = get("Engine Model");
  const disp = get("Displacement (L)");

  const engineDetails = classifyGMEngine(engineModel, disp);

  const decoded = {
    vin,
    year,
    make,
    model,
    engine: engineDetails?.code
      ? `${engineDetails.displacement_l}L ${engineDetails.code}`
      : engineModel || disp || "",
    engineDetails
  };

  await supabase.from("vin_decodes").upsert({
    vin,
    year,
    make,
    model,
    engine: decoded.engine,
    engine_details: engineDetails,
    raw: results
  });

  return decoded;
}
