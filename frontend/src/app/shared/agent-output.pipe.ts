import { Pipe, type PipeTransform } from '@angular/core';
import { MarkdownPipe } from './markdown.pipe.js';
import { splitTestSteps, type TestStep } from './test-output.js';

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

interface ToolCall {
  failed: boolean;
  command: string;
  result: string;
}

/** Entfernt die rechtsbündige Dauer („… 6s“), die das Terminal an umbrochene Zeilen anhängt. */
const stripDuration = (line: string): string => line.replace(/\s+…\s*\d+\s*m?s$/, '');

/** Formats the transcript of a CLI agent (● commands, └ results) as tool-call cards and the remaining text as Markdown. */
@Pipe({ name: 'agentOutput', standalone: true })
export class AgentOutputPipe implements PipeTransform {
  private readonly markdown = new MarkdownPipe();

  /** Testläufe als kompakte Karten (Befehl, Status, Kurzfazit), der Rest als Agent-Transkript bzw. Markdown. */
  transform(output: string | null | undefined): string {
    const html = splitTestSteps(output ?? '')
      .map((part) => (typeof part === 'string' ? this.transcript(part) : this.testCard(part)))
      .filter((part) => part && !part.startsWith('<p class="muted">Keine Inhalte'))
      .join('');
    return html || '<p class="muted">Keine Inhalte vorhanden.</p>';
  }

  private testCard(step: TestStep): string {
    const ok = step.status === 'passed';
    return (
      `<div class="test-step ${ok ? 'passed' : 'failed'}"><span class="test-icon" aria-hidden="true">${ok ? '✓' : '✕'}</span>` +
      `<div class="test-body"><div class="test-head"><code>${escape(step.command)}</code>` +
      `<span class="test-summary">${escape(step.summary)}</span></div>` +
      (step.raw
        ? `<details class="test-raw"><summary>Ausgabe</summary><pre>${escape(step.raw.slice(-6000))}</pre></details>`
        : '') +
      '</div></div>'
    );
  }

  private transcript(output: string): string {
    const lines = output.split(/\r?\n/);
    const parts: string[] = [];
    let text: string[] = [];
    const flushText = (): void => {
      if (text.join('').trim()) parts.push(this.markdown.transform(text.join('\n')));
      text = [];
    };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!/^[●✗✓] /.test(line)) {
        text.push(line);
        continue;
      }
      flushText();
      const call: ToolCall = { failed: line.startsWith('✗'), command: stripDuration(line.slice(2)), result: '' };
      let phase: 'command' | 'echo' | 'result' = 'command';
      for (index += 1; index < lines.length; index += 1) {
        const next = lines[index]!;
        if (/^[●✗✓] /.test(next) || (!next.startsWith(' ') && next.trim())) {
          index -= 1;
          break;
        }
        if (!next.trim()) {
          if (phase === 'result') break;
          continue;
        }
        if (next.trimStart().startsWith('│')) {
          phase = 'echo';
        } else if (next.trimStart().startsWith('└')) {
          phase = 'result';
          call.result = next.trimStart().slice(1).trim();
        } else if (phase === 'command') {
          call.command += ` ${stripDuration(next.trim())}`;
        } else if (phase === 'result') {
          call.result += ` ${next.trim()}`;
        }
      }
      parts.push(this.card(call));
    }
    flushText();
    return parts.join('');
  }

  private card(call: ToolCall): string {
    const command = call.command.trim();
    // „0 errors“, „no errors“, „keine Fehler“, „fehlerfrei“ melden Erfolg, nicht Fehler.
    const result = call.result.replace(/\b(?:0|no|keine?)\s+(?:errors?|fehler)\b|fehlerfrei/gi, '');
    const failed = call.failed || /denied|fehl|error/i.test(result);
    const icon = failed ? '✕' : '›';
    return (
      `<div class="tool-call${failed ? ' failed' : ''}"><span class="tool-icon" aria-hidden="true">${icon}</span>` +
      `<div class="tool-body"><code title="${escape(command)}">${escape(command.slice(0, 400))}</code>` +
      (call.result ? `<span class="tool-result">${escape(call.result)}</span>` : '') +
      '</div></div>'
    );
  }
}
