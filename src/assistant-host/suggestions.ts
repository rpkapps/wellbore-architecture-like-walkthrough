import type { Suggestion } from '../assistant/core/types';
import { FORMATION_BY_ID } from '../data/stratigraphy';
import type { App } from '../ui/app';
import { formationOf } from '../ui/selection';

/**
 * Prompts for the empty state and the composer: first those about the
 * selected object, then the general ones, at most six. Icon names are the
 * ones `renderIcon` knows.
 */
export function suggestions(app: App): Suggestion[] {
  const out: Suggestion[] = [];
  const e = app.engine;
  const well = e?.activeWell;
  const wname = well?.name ?? 'this well';
  const sel = app.selection.value;
  const title = app.inspector.value?.title;
  const fid = formationOf(sel);
  if (sel && fid) {
    const f = FORMATION_BY_ID.get(fid);
    const name = f?.name ?? title ?? fid;
    const inWell = well?.zones.some((z) => z.formationId === fid);
    if (inWell)
      out.push({
        label: `Summarise the ${name} in this well`,
        prompt: `Summarise the ${name} in ${wname}: depths (MD and TVDSS), thickness, net pay, porosity and Sw, and what the logs show there.`,
        description: `${wname} · petrophysics and logs`,
        icon: 'strata',
      });
    out.push({
      label: `Compare the ${name} across wells`,
      prompt: `How does the ${name} vary between the Volve wells? Compare its top depth (TVDSS), thickness and, where there are logs, its porosity and saturation.`,
      description: 'Tops and petrophysics per well',
      icon: 'columns',
    });
  } else if (sel?.kind === 'well') {
    const w = app.field.wells.find((x) => x.id === sel.id);
    const name = w?.name ?? title ?? sel.id;
    if (w && (w.logs || w.lasFile))
      out.push({ label: `Plot GR, resistivity and density logs for ${name}`, prompt: `Plot the GR, deep resistivity, density and neutron logs of ${name} across the reservoir, with the formation tops.`, description: 'A depth chart of the logs', icon: 'log-curve' });
    if (w?.productionMonthly.length)
      out.push({ label: `Chart ${name} production`, prompt: `Chart the monthly oil, gas and water production of ${name} and give its cumulative volumes and peak month.`, description: 'Monthly volumes and totals', icon: 'chart-line' });
    else if (!w) out.push({ label: `What is ${name}?`, prompt: `What is the wellbore ${name} I selected?`, icon: 'well' });
  } else if (sel?.kind === 'interval') {
    out.push({ label: 'Describe this interval', prompt: 'Describe the selected depth interval: zone, thickness, and the log and interpretation values across it.', description: title, icon: 'ruler' });
  } else if (sel?.kind === 'contact') {
    out.push({ label: 'How was this contact estimated?', prompt: 'How was the oil–water contact estimated, how certain is it, and which wells support it?', icon: 'droplets' });
  } else if (sel?.kind === 'overlay' && title) {
    out.push({ label: `What does ${title} show?`, prompt: `What does the ${title} layer show, and how should I read it?`, icon: 'layers' });
  }
  if (app.marking.value?.intervals.length) out.push({ label: 'What do the marked intervals have in common?', prompt: 'Describe the marked intervals: which zones they fall in, and their log and interpretation values compared with the rest of the well.', icon: 'highlighter' });

  const defaults: Suggestion[] = [
    { label: 'What am I looking at?', prompt: 'What am I looking at right now? Explain the well, the depth and formation the camera is at, and what the colours mean.', description: 'The view, explained', icon: 'eye' },
    { label: 'Chart monthly oil production for all wells', description: 'Volve production 2008–2016', icon: 'chart-line' },
    { label: 'Where is the best pay in this well?', prompt: `Where is the best pay in ${wname}? List the best net-pay intervals with depths, porosity and Sw, and offer to take me there.`, description: 'Net pay intervals, ranked', icon: 'target' },
    { label: 'Take me to the top of the reservoir', prompt: `Take me to the top of the Hugin reservoir in ${wname}.`, description: 'Flies to the top of the Hugin', icon: 'navigation' },
  ];
  for (const d of defaults) if (out.length < 6 && !out.some((s) => s.label === d.label)) out.push(d);
  return out;
}
