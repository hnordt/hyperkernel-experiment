export type SqliteCallCounts = Readonly<{
  statementPreparations: number;
  authorizerInstallations: number;
  authorizerClears: number;
}>;

const counts = {
  statementPreparations: 0,
  authorizerInstallations: 0,
  authorizerClears: 0,
};

export function recordStatementPreparation(): void {
  counts.statementPreparations += 1;
}

export function recordAuthorizerInstallation(): void {
  counts.authorizerInstallations += 1;
}

export function recordAuthorizerClear(): void {
  counts.authorizerClears += 1;
}

export function sqliteCallCounts(): SqliteCallCounts {
  return Object.freeze({ ...counts });
}
