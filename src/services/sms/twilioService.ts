import twilio from 'twilio';
import type { AvailableNumber } from '../../types/phone';

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID!;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN!;
const WEBHOOK_BASE_URL = process.env.TWILIO_WEBHOOK_BASE_URL ?? 'https://api.commune.email';

/** Parent account Twilio client (used for subaccount management and number discovery) */
export const parentClient = (): twilio.Twilio => twilio(ACCOUNT_SID, AUTH_TOKEN);

/** Subaccount-scoped Twilio client */
export function subaccountClient(subaccountSid: string, subaccountAuthToken: string): twilio.Twilio {
  return twilio(subaccountSid, subaccountAuthToken);
}

// ─── Subaccount Management ────────────────────────────────────────

export async function createSubaccount(friendlyName: string): Promise<{ sid: string; authToken: string }> {
  const account = await parentClient().api.v2010.accounts.create({ friendlyName });
  return { sid: account.sid, authToken: account.authToken };
}

// ─── Messaging Service Management ────────────────────────────────

export async function createMessagingService(
  client: twilio.Twilio,
  friendlyName: string
): Promise<string> {
  const service = await client.messaging.v1.services.create({
    friendlyName,
    inboundRequestUrl: `${WEBHOOK_BASE_URL}/api/webhooks/twilio/inbound`,
    inboundMethod: 'POST',
    // Sticky sender: first message to a recipient locks which number sends
    stickySender: true,
    // Prefer sender with matching area code
    areaCodeGeomatch: true,
    // Reduce segment count automatically (GSM-7 smart encoding)
    smartEncoding: true,
    statusCallback: `${WEBHOOK_BASE_URL}/api/webhooks/twilio/status`,
  });
  return service.sid;
}

export async function addNumberToMessagingService(
  client: twilio.Twilio,
  messagingServiceSid: string,
  twilioPhoneNumberSid: string
): Promise<void> {
  await client.messaging.v1.services(messagingServiceSid).phoneNumbers.create({
    phoneNumberSid: twilioPhoneNumberSid,
  });
}

export async function removeNumberFromMessagingService(
  client: twilio.Twilio,
  messagingServiceSid: string,
  twilioPhoneNumberSid: string
): Promise<void> {
  await client.messaging.v1
    .services(messagingServiceSid)
    .phoneNumbers(twilioPhoneNumberSid)
    .remove();
}

// ─── Phone Number Search ─────────────────────────────────────────

export async function searchAvailableNumbers(params: {
  client: twilio.Twilio;
  country?: string;
  areaCode?: string;
  type?: 'Local' | 'TollFree';
  smsEnabled?: boolean;
  mmsEnabled?: boolean;
  contains?: string;
  inRegion?: string;
  limit?: number;
}): Promise<AvailableNumber[]> {
  const {
    client,
    country = 'US',
    areaCode,
    type = 'TollFree',
    smsEnabled = true,
    mmsEnabled,
    contains,
    inRegion,
    limit = 20,
  } = params;

  const searchParams: Record<string, unknown> = {
    smsEnabled,
    limit,
  };
  if (areaCode && type === 'Local') searchParams.areaCode = parseInt(areaCode, 10);
  if (mmsEnabled !== undefined) searchParams.mmsEnabled = mmsEnabled;
  if (contains) searchParams.contains = contains;
  if (inRegion) searchParams.inRegion = inRegion;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let results: any[];

  if (type === 'TollFree') {
    results = await client.availablePhoneNumbers(country).tollFree.list(searchParams as any);
  } else {
    results = await client.availablePhoneNumbers(country).local.list(searchParams as any);
  }

  return (results as Array<{
    phoneNumber: string;
    friendlyName: string;
    region?: string;
    isoCountry: string;
    // Twilio SDK returns 'SMS'/'MMS' (uppercase) for toll-free, 'sms'/'mms' for local
    capabilities: Record<string, boolean>;
    beta: boolean;
  }>).map((n) => ({
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
    region: n.region,
    isoCountry: n.isoCountry,
    capabilities: {
      sms: !!(n.capabilities.sms ?? n.capabilities.SMS),
      mms: !!(n.capabilities.mms ?? n.capabilities.MMS),
      voice: !!(n.capabilities.voice ?? n.capabilities.Voice),
    },
    beta: n.beta ?? false,
  }));
}

// ─── Phone Number Provisioning ────────────────────────────────────

export async function purchasePhoneNumber(
  client: twilio.Twilio,
  phoneNumber: string
): Promise<{ twilioSid: string; capabilities: { sms: boolean; mms: boolean; voice: boolean }; numberType: 'local' | 'tollfree' | 'shortcode' }> {
  // Webhook is handled at Messaging Service level — don't set SmsUrl here
  const incoming = await client.incomingPhoneNumbers.create({
    phoneNumber,
    friendlyName: 'Commune Agent Number',
  });

  const caps = incoming.capabilities as { sms?: boolean; mms?: boolean; voice?: boolean };
  const isTollFree = phoneNumber.startsWith('+1800') ||
    phoneNumber.startsWith('+1833') ||
    phoneNumber.startsWith('+1844') ||
    phoneNumber.startsWith('+1855') ||
    phoneNumber.startsWith('+1866') ||
    phoneNumber.startsWith('+1877') ||
    phoneNumber.startsWith('+1888');

  return {
    twilioSid: incoming.sid,
    capabilities: {
      sms: caps.sms ?? true,
      mms: caps.mms ?? false,
      voice: caps.voice ?? false,
    },
    numberType: isTollFree ? 'tollfree' : 'local',
  };
}

export async function releasePhoneNumber(
  client: twilio.Twilio,
  twilioSid: string
): Promise<void> {
  await client.incomingPhoneNumbers(twilioSid).remove();
}

// ─── SMS Send ────────────────────────────────────────────────────

export interface SendSmsParams {
  client: twilio.Twilio;
  from?: string;                   // E.164; omit to use Messaging Service sticky sender
  messagingServiceSid?: string;    // MG... SID; used when from is omitted
  to: string;                      // E.164
  body: string;
  mediaUrl?: string[];
  validityPeriod?: number;         // seconds; message expires if undelivered
}

export interface SendSmsResult {
  sid: string;
  status: string;
  numSegments: string;
  price?: string;
  priceUnit?: string;
}

export async function sendSms(params: SendSmsParams): Promise<SendSmsResult> {
  const { client, from, messagingServiceSid, to, body, mediaUrl, validityPeriod } = params;

  const payload: Parameters<typeof client.messages.create>[0] = {
    to,
    body,
    statusCallback: `${WEBHOOK_BASE_URL}/api/webhooks/twilio/status`,
  };

  if (from) {
    payload.from = from;
  } else if (messagingServiceSid) {
    payload.messagingServiceSid = messagingServiceSid;
  }

  if (mediaUrl && mediaUrl.length > 0) {
    payload.mediaUrl = mediaUrl;
  }

  if (validityPeriod) {
    payload.validityPeriod = validityPeriod;
  }

  const msg = await client.messages.create(payload);
  return {
    sid: msg.sid,
    status: msg.status,
    numSegments: msg.numSegments ?? '1',
    price: msg.price ?? undefined,
    priceUnit: msg.priceUnit ?? undefined,
  };
}

// ─── Webhook Signature Validation ────────────────────────────────

/**
 * Validate Twilio webhook signature using HMAC-SHA1.
 * IMPORTANT: Twilio uses Auth Token (not a separate webhook secret) and HMAC-SHA1 (not SHA-256).
 * The full URL including query params must be passed.
 */
export function validateWebhookSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>
): boolean {
  if (!authToken) return false;
  return twilio.validateRequest(authToken, signature, url, params);
}

// ─── Keyword Detection ───────────────────────────────────────────

const STOP_KEYWORDS = /^(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i;
const START_KEYWORDS = /^(start|yes|unstop)\s*$/i;

export function isStopKeyword(body: string): boolean {
  return STOP_KEYWORDS.test(body.trim());
}

export function isStartKeyword(body: string): boolean {
  return START_KEYWORDS.test(body.trim());
}

// ─── MMS Media Fetch ─────────────────────────────────────────────

/**
 * Fetch MMS media from Twilio's CDN.
 * Twilio media URLs require Basic Auth with subaccount credentials.
 */
export async function fetchMmsMedia(
  mediaUrl: string,
  subaccountSid: string,
  subaccountAuthToken: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const credentials = Buffer.from(`${subaccountSid}:${subaccountAuthToken}`).toString('base64');
  const response = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch MMS media: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const arrayBuffer = await response.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType };
}
