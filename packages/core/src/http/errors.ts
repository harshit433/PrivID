/**
 * Error model. Every failure the API returns is an `AppError` carrying a stable
 * machine code (the mobile client switches on `error.code`), an HTTP status, and a
 * human message. The catalog below is the single source of truth for codes so the
 * same string is never spelled two ways.
 */

export interface AppErrorDetails {
  [key: string]: unknown;
}

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: AppErrorDetails,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Catalog entry: default status + default message for a code. */
interface Spec {
  status: number;
  message: string;
}

/**
 * Canonical error codes. Grouped by concern. Keep in sync with the mobile
 * error-code union. `throwError('CODE')` uses the default message; pass a second
 * arg to override, and a third for structured details.
 */
export const ERRORS = {
  // Generic
  VALIDATION_ERROR: { status: 400, message: 'The request was invalid.' },
  BAD_REQUEST: { status: 400, message: 'Bad request.' },
  UNAUTHORIZED: { status: 401, message: 'Authentication required.' },
  TOKEN_EXPIRED: { status: 401, message: 'Your session expired. Please sign in again.' },
  INVALID_TOKEN: { status: 401, message: 'Invalid access token.' },
  FORBIDDEN: { status: 403, message: 'You do not have permission to do that.' },
  NOT_FOUND: { status: 404, message: 'Not found.' },
  CONFLICT: { status: 409, message: 'That conflicts with the current state.' },
  RATE_LIMITED: { status: 429, message: 'Too many requests. Please slow down.' },
  INTERNAL_ERROR: { status: 500, message: 'Something went wrong.' },
  SERVICE_UNAVAILABLE: { status: 503, message: 'Service temporarily unavailable.' },
  NOT_CONFIGURED: { status: 503, message: 'This feature is not configured.' },

  // Account / identity
  USER_INACTIVE: { status: 401, message: 'Account not found or inactive.' },
  ACCOUNT_SUSPENDED: { status: 403, message: 'This account is suspended.' },
  ACCOUNT_BANNED: { status: 403, message: 'This account has been banned.' },
  ACCOUNT_UNDER_REVIEW: { status: 403, message: 'This account is under review.' },
  IDENTITY_ALREADY_CLAIMED: { status: 409, message: 'This identity is already linked to an account.' },

  // Auth
  HANDLE_INVALID: { status: 400, message: 'Handles can use letters, numbers, dots and underscores.' },
  HANDLE_TAKEN: { status: 409, message: 'That handle is already taken.' },
  HANDLE_LOCKED: { status: 409, message: 'Your previous handle is reserved for your return.' },
  HANDLE_NOT_FOUND: { status: 404, message: 'No TrustRoute account found with that handle.' },
  PIN_INVALID: { status: 401, message: 'Incorrect PIN.' },
  PIN_LOCKED: { status: 429, message: 'Too many attempts. Try again later.' },
  PIN_NOT_SET: { status: 409, message: 'No PIN is set for this account.' },
  LEGACY_AUTH_DISABLED: { status: 410, message: 'This sign-in path is no longer available.' },

  // Onboarding
  ONBOARDING_EXPIRED: { status: 410, message: 'Your verification session expired. Please start again.' },
  ONBOARDING_STATE_INVALID: { status: 409, message: 'That step cannot be completed right now.' },
  KYC_FAILED: { status: 400, message: 'Identity verification could not be completed.' },
  LIVENESS_FAILED: { status: 400, message: 'Face verification did not pass. Please try again.' },
  DEVICE_BANNED: { status: 403, message: 'This device is not permitted to create an account.' },

  // Calls / reachability
  CALL_RATE_LIMITED: { status: 429, message: 'You are initiating calls too quickly.' },
  CALL_NOT_ALLOWED: { status: 403, message: 'You cannot call this person right now.' },
  CALL_NOT_FOUND: { status: 404, message: 'Call not found.' },
  BLOCKED: { status: 403, message: 'This connection is blocked.' },

  // Wallet / payments
  INSUFFICIENT_BALANCE: { status: 402, message: 'Not enough wallet balance.' },
  PAYMENT_FAILED: { status: 402, message: 'Payment could not be processed.' },

  // Chat
  CHAT_RATE_LIMITED: { status: 429, message: 'You are sending messages too quickly.' },
  CHAT_NOT_ALLOWED: { status: 403, message: 'You cannot message this person right now.' },
} as const satisfies Record<string, Spec>;

export type ErrorCode = keyof typeof ERRORS;

/** Build an AppError from the catalog, optionally overriding message/details. */
export function appError(code: ErrorCode, message?: string, details?: AppErrorDetails): AppError {
  const spec = ERRORS[code];
  return new AppError(spec.status, code, message ?? spec.message, details);
}

/** Throw a catalog error. */
export function throwError(code: ErrorCode, message?: string, details?: AppErrorDetails): never {
  throw appError(code, message, details);
}
