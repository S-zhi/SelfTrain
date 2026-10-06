export class DomainError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
