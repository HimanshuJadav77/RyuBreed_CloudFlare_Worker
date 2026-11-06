export function nowUtc(): Date {
  return new Date();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + Math.round(days * 86400000));
}

export function isPast(date: Date): boolean {
  return date.getTime() <= Date.now();
}

export function remainingDays(expiryDate: Date): number {
  const diffMs = expiryDate.getTime() - Date.now();
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

