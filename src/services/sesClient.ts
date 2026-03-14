import { SESv2Client } from '@aws-sdk/client-sesv2';

const region = process.env.AWS_REGION || 'us-east-1';

const sesClient = new SESv2Client({
  region,
  ...(process.env.AWS_ACCESS_KEY_ID && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
});

export default sesClient;
