import { Pipe, type PipeTransform } from '@angular/core';
import { formatDateTime, formatDuration, formatHours, formatIsoDate, formatNumber, shortText } from './format.js';
import { priorityLabel, severityLabel, statusClass, statusLabel } from './labels.js';

@Pipe({ name: 'statusLabel', standalone: true })
export class StatusLabelPipe implements PipeTransform {
  transform(status: string): string {
    return statusLabel(status);
  }
}

@Pipe({ name: 'statusClass', standalone: true })
export class StatusClassPipe implements PipeTransform {
  transform(status: string): string {
    return statusClass(status);
  }
}

@Pipe({ name: 'priorityLabel', standalone: true })
export class PriorityLabelPipe implements PipeTransform {
  transform(priority: string): string {
    return priorityLabel(priority);
  }
}

@Pipe({ name: 'severityLabel', standalone: true })
export class SeverityLabelPipe implements PipeTransform {
  transform(severity: string): string {
    return severityLabel(severity);
  }
}

@Pipe({ name: 'hours', standalone: true })
export class HoursPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    return formatHours(value);
  }
}

@Pipe({ name: 'localeNumber', standalone: true })
export class LocaleNumberPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    return formatNumber(value);
  }
}

@Pipe({ name: 'dateTime', standalone: true })
export class DateTimePipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    return formatDateTime(value);
  }
}

@Pipe({ name: 'duration', standalone: true })
export class DurationPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    return formatDuration(value);
  }
}

@Pipe({ name: 'isoDate', standalone: true })
export class IsoDatePipe implements PipeTransform {
  transform(value: string): string {
    return formatIsoDate(value);
  }
}

@Pipe({ name: 'shortText', standalone: true })
export class ShortTextPipe implements PipeTransform {
  transform(text: string | null | undefined, limit = 200): string {
    return shortText(text, limit);
  }
}
