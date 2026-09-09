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

/**
 * Stage 6b shop-admin errors. The admin side is a third kind of login (not the
 * agency's GitHub session, not a customer account), so it gets its own typed
 * errors rather than reusing customer messages that talk about "accounts".
 */
export class ShopAdminNotSignedInError extends UnauthorizedError {
  constructor(message = "Please sign in to continue.") {
    super(message);
    this.name = "ShopAdminNotSignedInError";
  }
}

/** Every login failure — unknown email, wrong password, invited-but-not-yet-active, disabled — says exactly this. */
export class InvalidShopAdminCredentialsError extends UnauthorizedError {
  constructor(message = "Email or password is incorrect.") {
    super(message);
    this.name = "InvalidShopAdminCredentialsError";
  }
}

export class InvalidShopAdminLinkError extends BadRequestError {
  constructor(message = "This link is invalid or has expired.") {
    super(message);
    this.name = "InvalidShopAdminLinkError";
  }
}

export class ShopOwnerExistsError extends ConflictError {
  constructor(message = "This shop already has an owner login.") {
    super(message);
    this.name = "ShopOwnerExistsError";
  }
}

export class ShopAdminExistsError extends ConflictError {
  constructor(message = "Someone with that email already has a login here.") {
    super(message);
    this.name = "ShopAdminExistsError";
  }
}

export class ShopLoginCapError extends ConflictError {
  constructor(message = "This shop already has 10 logins.") {
    super(message);
    this.name = "ShopLoginCapError";
  }
}

/** Members may open the Team API, but only the owner may change the team. */
export class ShopOwnerOnlyError extends ForbiddenError {
  constructor(message = "Only the shop owner can do this.") {
    super(message);
    this.name = "ShopOwnerOnlyError";
  }
}

/**
 * Stage 6c — a shop-admin write the signed-in login lacks the permission box
 * for. The owner always passes; a member sees this when the owner never
 * ticked (or unticked) the box for this action.
 */
export class ShopPermissionError extends ForbiddenError {
  constructor(
    message = "Your login does not include this action. Ask the shop owner.",
  ) {
    super(message);
    this.name = "ShopPermissionError";
  }
}

/** The owner row cannot be disabled, downgraded or edited through the admin side. */
export class ShopOwnerLockedError extends ForbiddenError {
  constructor(message = "The owner login cannot be changed here.") {
    super(message);
    this.name = "ShopOwnerLockedError";
  }
}
