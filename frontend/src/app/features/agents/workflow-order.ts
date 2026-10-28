import type { AgentPhase, WorkflowStep } from '../../core/models.js';

/** Neue Reihenfolge einer Phase, wie sie an `POST /projects/:slug/workflow/order` geht. */
export interface PhaseOrder {
  phase: AgentPhase;
  ids: string[];
}

/** Schritte einer Phase in Ablauf-Reihenfolge. */
export function stepsInPhase(steps: readonly WorkflowStep[], phase: AgentPhase): WorkflowStep[] {
  return steps.filter((step) => step.phase === phase).sort((a, b) => a.position - b.position);
}

/**
 * Reihenfolgen nach dem Verschieben eines Schritts: zuerst die Zielphase, bei einem Phasenwechsel danach die
 * Quellphase ohne den Schritt (damit ihre Positionen lückenlos ab 1 laufen). `slot` ist die Einfügestelle in der
 * angezeigten Liste der Zielphase (0 = vor dem ersten Schritt, Länge = ans Ende), den Schritt selbst mitgezählt.
 * Ohne Änderung oder bei unbekanntem Schritt: leere Liste.
 */
export function moveStep(
  steps: readonly WorkflowStep[],
  stepId: string,
  phase: AgentPhase,
  slot: number,
): PhaseOrder[] {
  const step = steps.find((entry) => entry.id === stepId);
  if (!step) return [];
  const sourceIds = stepsInPhase(steps, step.phase).map((entry) => entry.id);
  const targetIds = step.phase === phase ? sourceIds : stepsInPhase(steps, phase).map((entry) => entry.id);
  const from = targetIds.indexOf(stepId);
  let index = Math.max(0, Math.min(slot, targetIds.length));
  // In derselben Phase fällt der Schritt vor der Einfügestelle weg.
  if (from >= 0 && from < index) index -= 1;
  const ids = targetIds.filter((id) => id !== stepId);
  ids.splice(index, 0, stepId);
  if (step.phase === phase) return ids.join() === sourceIds.join() ? [] : [{ phase, ids }];
  return [
    { phase, ids },
    { phase: step.phase, ids: sourceIds.filter((id) => id !== stepId) },
  ];
}

/** Reihenfolgen lokal übernehmen (Phase und Position ab 1), bis der Server den gespeicherten Stand liefert. */
export function applyOrders(steps: readonly WorkflowStep[], orders: readonly PhaseOrder[]): WorkflowStep[] {
  const placed = new Map<string, { phase: AgentPhase; position: number }>();
  for (const order of orders)
    order.ids.forEach((id, index) => placed.set(id, { phase: order.phase, position: index + 1 }));
  return steps.map((step) => {
    const place = placed.get(step.id);
    return place ? { ...step, ...place } : step;
  });
}
