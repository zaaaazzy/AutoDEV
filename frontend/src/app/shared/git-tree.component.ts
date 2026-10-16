import { Component, input } from '@angular/core';
import type { Sprint } from '../core/models.js';

export interface GitNode {
  kind: 'step' | 'branch' | 'commit' | 'empty';
  label?: string;
  text: string;
  detail?: string;
}

export function branchNode(sprint: Sprint): GitNode {
  return { kind: 'branch', label: 'Branch', text: sprint.gitBranch || 'main' };
}

export function commitNode(sprint: Sprint): GitNode {
  return sprint.gitCommit
    ? { kind: 'commit', text: sprint.gitCommit, detail: sprint.gitMessage ?? undefined }
    : { kind: 'empty', text: 'Noch kein Commit' };
}

/** Gemeinsame Git-Verlaufsansicht für Sprints und Ideen; Aktionen können darunter eingeblendet werden. */
@Component({
  selector: 'app-git-tree',
  standalone: true,
  templateUrl: './git-tree.component.html',
})
export class GitTreeComponent {
  readonly nodes = input.required<GitNode[]>();
}
