/**
 * Typed, safe API errors.
 *
 * Only instances of ApiError (or its subclasses) are trusted to control the
 * HTTP status and message returned to a browser. Everything else becomes an
 * opaque 500. This prevents message-text heuristics, status-property
 * injection, and accidental leakage of driver details.
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    // Ensure instanceof works across transpiled boundaries.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BadRequestError extends ApiError {
  constructor(message = "Invalid request") {
    super(message, 400);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "Authentication is required") {
    super(message, 401);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "Forbidden") {
    super(message, 403);
  }
}

export class NotFoundError extends ApiError {
  constructor(message = "Not found") {
    super(message, 404);
  }
}

export class ConflictError extends ApiError {
  constructor(message = "Conflict") {
    super(message, 409);
  }
}

export class PayloadTooLargeError extends ApiError {
  constructor(message = "Request body too large") {
    super(message, 413);
  }
}

export class RateLimitError extends ApiError {
  constructor(
    message = "Rate limit exceeded. Please wait before trying again.",
  ) {
    super(message, 429);
  }
}

export class EmailDeliveryError extends ApiError {
  constructor(message = "Customer email delivery is temporarily unavailable.") {
    super(message, 502);
  }
}

export class ConfigurationError extends ApiError {
  constructor(
    message = "Service configuration is incomplete or invalid for this deployment.",
  ) {
    super(message, 503);
  }
}

/**
 * Customer-specific typed errors that map to intentional statuses.
 * These extend ApiError so safeApiError trusts them.
 */

export class CustomerEmailDeliveryError extends EmailDeliveryError {
  constructor() {
    super("Customer email delivery is temporarily unavailable.");
    this.name = "CustomerEmailDeliveryError";
  }
}

export class CustomerEmailConfigurationError extends ConfigurationError {
  constructor() {
    super("Customer email delivery is not configured for this deployment.");
    this.name = "CustomerEmailConfigurationError";
  }
}

export class CustomerAccountExistsError extends ConflictError {
  constructor(message = "An account with that email already exists.") {
    super(message);
    this.name = "CustomerAccountExistsError";
  }
}

export class InvalidCustomerCredentialsError extends UnauthorizedError {
  constructor(message = "The email or password is incorrect.") {
    super(message);
    this.name = "InvalidCustomerCredentialsError";
  }
}

export class InvalidOrderClaimError extends BadRequestError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOrderClaimError";
  }
}

export class InvalidPasswordResetError extends BadRequestError {
  constructor(message = "This password-reset link is invalid or has expired.") {
    super(message);
    this.name = "InvalidPasswordResetError";
  }
}

export class CustomerNotConnectedError extends UnauthorizedError {
  constructor(message = "Please sign in to continue.") {
    super(message);
    this.name = "CustomerNotConnectedError";
  }
}

/**
 * Generic not-connected error for GitHub/Studio owners.
 */
export class NotConnectedError extends UnauthorizedError {
  constructor(
    message = "Connect GitHub to continue. Valmont runs against your real repositories.",
  ) {
    super(message);
    this.name = "NotConnectedError";
  }
}

/**
 * Chat / Task / Memory / Repository / Branch not-found helpers.
 */
export class ChatNotFoundError extends NotFoundError {
  constructor(message = "Chat not found") {
    super(message);
    this.name = "ChatNotFoundError";
  }
}

export class TaskNotFoundError extends NotFoundError {
  constructor(message = "Task not found") {
    super(message);
    this.name = "TaskNotFoundError";
  }
}

export class MemoryNotFoundError extends NotFoundError {
  constructor(message = "Memory not found") {
    super(message);
    this.name = "MemoryNotFoundError";
  }
}

export class RepositoryNotFoundError extends NotFoundError {
  constructor(message = "Repository not found") {
    super(message);
    this.name = "RepositoryNotFoundError";
  }
}

/**
 * GitHub provider errors are mapped to safe typed errors at the boundary.
 */
export class GitHubApiError extends ApiError {
  constructor(message: string, status: number) {
    // Clamp GitHub status into 400-599, but keep original for mapping.
    const safeStatus = status >= 400 && status <= 599 ? status : 502;
    super(message, safeStatus);
    this.name = "GitHubApiError";
  }
}
