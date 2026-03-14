import MessageValidator from 'sns-validator';

const validator = new MessageValidator();

/**
 * Verify an incoming SNS HTTP notification.
 * Returns the parsed message if valid, throws if invalid.
 */
export const verifySnsMessage = (message: Record<string, any>): Promise<Record<string, any>> => {
  return new Promise((resolve, reject) => {
    validator.validate(message, (err, msg) => {
      if (err) return reject(err);
      resolve(msg as Record<string, any>);
    });
  });
};
