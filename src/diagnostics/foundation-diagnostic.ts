export type FoundationDiagnosticCode =
  | `E-SETUP-${string}`
  | `E-INVENTORY-${string}`
  | `E-SEMANTICS-${string}`
  | `E-BINDING-${string}`
  | `E-SIGNATURE-${string}`
  | `E-SCOPE-${string}`;

export interface FoundationDiagnosticJson {
  schemaVersion: 1;
  code: FoundationDiagnosticCode;
  operation: string;
  message: string;
  remediation: string;
  path?: string;
  identifier?: string;
}

export interface FoundationDiagnosticInput {
  code: FoundationDiagnosticCode;
  operation: string;
  message: string;
  remediation: string;
  path?: string;
  identifier?: string;
}

/**
 * A bounded operator diagnostic. It deliberately carries no arbitrary
 * metadata or cause so JSON output cannot accidentally cross the local
 * content and secret boundary.
 */
export class FoundationDiagnosticError extends Error {
  readonly code: FoundationDiagnosticCode;
  readonly operation: string;
  readonly remediation: string;
  readonly path?: string;
  readonly identifier?: string;

  constructor(input: FoundationDiagnosticInput) {
    super(input.message);
    this.name = 'FoundationDiagnosticError';
    this.code = input.code;
    this.operation = input.operation;
    this.remediation = input.remediation;
    this.path = input.path;
    this.identifier = input.identifier;
  }

  toJSON(): FoundationDiagnosticJson {
    return {
      schemaVersion: 1,
      code: this.code,
      operation: this.operation,
      message: this.message,
      remediation: this.remediation,
      ...(this.path ? { path: this.path } : {}),
      ...(this.identifier ? { identifier: this.identifier } : {}),
    };
  }
}

export function isFoundationDiagnosticError(
  value: unknown,
): value is FoundationDiagnosticError {
  return value instanceof FoundationDiagnosticError;
}

export function foundationDiagnosticJson(
  error: unknown,
  operation = 'unknown',
): FoundationDiagnosticJson {
  if (isFoundationDiagnosticError(error)) return error.toJSON();
  return {
    schemaVersion: 1,
    code: 'E-SETUP-999',
    operation,
    message: 'Glirastes command failed.',
    remediation: 'inspect-local-diagnostics',
  };
}
