import type { ExtractionMetrics, FieldNode, InteractiveNode, RegionNode, UnresolvedItem } from '@/lib/formgraph/types';

export function computeMetrics(
  controlsSeen: number,
  fields: FieldNode[],
  regions: RegionNode[],
  interactives: InteractiveNode[],
  unresolved: UnresolvedItem[],
  dropped: Record<string, number> = {},
): ExtractionMetrics {
  const labeledHighConf = fields.filter((f) => f.labelConfidence === 'high').length;
  const regionsAmbiguous = regions.filter((r) => r.confidence !== 'high').length;

  return {
    controlsSeen,
    dropped,
    fieldsResolved: fields.length,
    coverage: controlsSeen > 0 ? fields.length / controlsSeen : fields.length > 0 ? 1 : 0,
    labeledHighConf,
    labeledRate: fields.length > 0 ? labeledHighConf / fields.length : 0,
    regionsClassified: regions.length,
    regionsAmbiguous,
    interactivesPending: interactives.filter((i) => i.status === 'pending').length,
    interactivesActivated: interactives.filter((i) => i.status === 'activated').length,
    unresolvedCount: unresolved.length,
  };
}
