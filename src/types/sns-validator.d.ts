declare module 'sns-validator' {
  class MessageValidator {
    validate(
      message: Record<string, any>,
      callback: (err: Error | null, message: Record<string, any>) => void
    ): void;
  }
  export = MessageValidator;
}
