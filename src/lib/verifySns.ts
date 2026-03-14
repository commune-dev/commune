import MessageValidator from 'sns-validator';

const validator = new MessageValidator();

/**
 * Verify an incoming SNS HTTP notification using certificate-based signature validation.
 * Returns the parsed message if valid, throws if invalid.
 */
export const verifySnsMessage = (message: Record<string, any>): Promise<Record<string, any>> => {
  return new Promise((resolve, reject) => {
    validator.validate(message, (err: Error | null, msg: Record<string, any>) => {
      if (err) return reject(err);
      resolve(msg);
    });
  });
};
