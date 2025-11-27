// Prompts in English for model reliability. Outputs are Bulgarian JSON.

export function buildStep1Prompt({side}) {
  return {
    system: `You are iris_stage_1_quality_and_axes.
You receive one pre-aligned iris photo (${side} eye).
Goal: decide if image is analyzable, and define the coordinate frame robustly.

Hard constraints:
- Use HORIZONTAL IRIS AXIS as reference (9:00–6:00 line), because top iris may be partially covered by eyelid.
- Do NOT use pupil center as radius origin.
- Radius normalization: define a reference radius Rref as segment from PUPIL EDGE to IRIS EDGE along minute=15 direction.
- Detect specular highlights/glare and mark them as invalid regions.
- No health interpretations.

Return JSON only.`,
    user: `TASK:
1) Assess image quality: focus, blur, occlusion, glare/exposure.
2) Confirm coordinate frame:
   - minute 0 at 12:00 (top), minutes increase clockwise, 0..59
   - axis: horizontal 9-6 baseline
   - Rref measured along minute=15 ray from pupil edge to iris edge (not pupil center)
3) Output invalid regions as minute ranges.

OUTPUT JSON:
{
  "side":"R|L",
  "quality":{"ok":true|false,"issues":["..."],"confidence":0.0-1.0},
  "frame":{
    "minute_def":"0=12:00; +clockwise; 15=3:00; 30=6:00; 45=9:00",
    "axis":"horizontal_9_6",
    "radius_ref":"pupil_edge_to_iris_edge_along_minute_15"
  },
  "invalid_regions":[{"minute":[start,end],"reason":"glare|lid|lash|blur"}]
}`
  };
}

export function buildStep2Prompt({side, group}) {
  const groupInstructions = {
    LESIONS: `Detect ONLY: lacuna, crypt, giant_lacuna, collarette_defect_lesion, atrophic_area.`,
    RADIAL: `Detect ONLY: radial_furrow, deep_radial_cleft, transversal_fiber.`,
    RINGS: `Detect ONLY: nerve_ring, scurf_rim, sodium_ring, lymphatic_rosary.`,
    PIGMENT: `Detect ONLY: pigment_spot, pigment_cloud, pigment_band, brushfield_like_spots.`,
    COLLARETTE: `Detect ONLY: collarette_position, collarette_shape.`
  }[group] || "Detect nothing.";

  return {
    system: `You are iris_stage_2_detector_${group}.
Detect visual objects only. No medical meaning.

COORDINATE:
- minute: 0..59 (0=12:00 top, clockwise)
- ring: 1..12 by normalized radius rNorm
- rNorm = distance(pupil_edge -> feature) / Rref
- Rref = distance(pupil_edge -> iris_edge) along minute=15 ray

RING MAP (12 rings):
1:0.00-0.08, 2:0.08-0.16, 3:0.16-0.24, 4:0.24-0.32,
5:0.32-0.40, 6:0.40-0.48, 7:0.48-0.56, 8:0.56-0.64,
9:0.64-0.72, 10:0.72-0.80, 11:0.80-0.90, 12:0.90-1.00

STRICT:
- If uncertain: probable/suspected or omit.
- Never invent. JSON only.

${groupInstructions}`,
    user: `SIDE: ${side}
RETURN JSON:
{
  "side":"R|L",
  "group":"${group}",
  "findings":[
    {"type":"...", "minute":[start,end] OR minute_int, "ring":[start,end] OR ring_int, "confidence":0.0-1.0, "status":"definite|probable|suspected", "note":"<=80 chars, Bulgarian"}
  ],
  "quality_notes":"Bulgarian; short"
}`
  };
}

export function buildStep5SynthesisPrompt({coordJSON, questionnaire, detections}) {
  return {
    system: `You are iris_stage_5_synthesis_report.
You receive:
- coordinate map (zones/organs by minute+ring)
- detected signs with minute+ring
- questionnaire context

Goal: Bulgarian JSON report for frontend.

Rules:
- Priority: high if supported by questionnaire; medium if not mentioned; low if contradicts.
- No medical diagnosis names; preventive / functional language.
- Keep strings short; no quotes inside strings.
- JSON only.`,
    user: `COORD_MAP_JSON (v9): ${coordJSON}

QUESTIONNAIRE:
${questionnaire}

DETECTIONS_JSON:
${detections}

OUTPUT JSON EXACT:
{
  "analysis":{
    "zones":[
      {"id":1,"name":"зона","organ":"орган/система","status":"normal|attention|concern","findings":"<=60 символа","angle":[0,30]}
    ],
    "artifacts":[
      {"type":"тип","location":"minute 12-18; ring 4-5","description":"<=60 символа","severity":"low|medium|high","priority":"high|medium|low"}
    ],
    "overallHealth":0-100,
    "systemScores":[
      {"system":"Храносмилателна","score":0-100,"description":"<=60 символа"}
    ],
    "advice":{
      "top_actions":["<=60 символа","..."],
      "foods_focus":["..."],
      "avoid":["..."]
    }
  }
}`
  };
}
