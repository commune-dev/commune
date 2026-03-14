import 'dotenv/config';
import { GetEmailIdentityCommand } from '@aws-sdk/client-sesv2';
import sesClient from '../services/sesClient';
import domainService from '../services/domainService';
import domainStore from '../stores/domainStore';

type DnsRecord = {
  record?: string;
  name?: string;
  value?: string;
  ttl?: string | number;
  priority?: number;
  status?: string;
};

const printRecords = (records: DnsRecord[]) => {
  if (!records.length) {
    console.log('No DNS records returned.');
    return;
  }
  console.log('\nDNS records to add/update:');
  for (const record of records) {
    const type = record.record || '';
    const name = record.name || '';
    const value = record.value || '';
    const ttl = record.ttl ?? '';
    const status = record.status || 'pending';
    console.log(`- ${type}  ${name}  ${value}  ttl=${ttl}  status=${status}`);
  }
};

const normalize = (value: string) => value.trim().toLowerCase();

const run = async () => {
  const defaultDomainName = process.env.DEFAULT_DOMAIN_NAME;
  const configuredDefaultDomainId = process.env.DEFAULT_DOMAIN_ID;

  if (!defaultDomainName) {
    throw new Error('DEFAULT_DOMAIN_NAME is required');
  }

  // Check if domain already exists in SES
  let domainId: string;
  let domainExists = false;
  try {
    const sesStatus = await sesClient.send(new GetEmailIdentityCommand({ EmailIdentity: defaultDomainName }));
    domainExists = true;
    domainId = defaultDomainName; // SES uses domain name as ID
    console.log(`Found existing SES domain: ${defaultDomainName} (VerifiedForSending: ${sesStatus.VerifiedForSendingStatus})`);
  } catch (err: any) {
    if (err?.name !== 'NotFoundException') throw err;
    domainExists = false;
    domainId = defaultDomainName;
  }

  if (!domainExists) {
    const created = await domainService.createDomain({ name: defaultDomainName, orgId: null });
    if (created.error || !created.data) {
      throw new Error(`Failed to create SES domain: ${JSON.stringify(created.error ?? 'no data returned')}`);
    }
    domainId = created.data.id;
    console.log(`Created SES domain: ${defaultDomainName} (${domainId})`);
  }

  const { data: refreshData, error: refreshError } = await domainService.refreshDomainRecords(domainId);
  if (refreshError || !refreshData) {
    throw new Error(`Failed to refresh domain records: ${JSON.stringify(refreshError)}`);
  }

  await domainStore.upsertDomain({
    id: refreshData.id,
    name: refreshData.name,
    status: refreshData.status,
    region: refreshData.region,
    records: refreshData.records || [],
    createdAt: refreshData.created_at,
  });

  const stored = await domainStore.getDomain(domainId);
  console.log('\nStored default domain in DB:');
  console.log(`- id: ${stored?.id || domainId}`);
  console.log(`- name: ${stored?.name || defaultDomainName}`);
  console.log(`- status: ${stored?.status || refreshData.status || 'unknown'}`);

  printRecords((refreshData.records || []) as DnsRecord[]);

  console.log('\nRequired backend env values:');
  console.log(`- DEFAULT_DOMAIN_NAME=${defaultDomainName}`);
  console.log(`- DEFAULT_DOMAIN_ID=${domainId}`);

  if (!configuredDefaultDomainId || normalize(configuredDefaultDomainId) !== normalize(domainId)) {
    console.log('\nAction required: update DEFAULT_DOMAIN_ID to the domain name above and redeploy backend.');
  } else {
    console.log('\nDEFAULT_DOMAIN_ID already matches SES domain id.');
  }
};

run()
  .then(() => {
    console.log('\nDefault domain bootstrap complete.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Default domain bootstrap failed:', error);
    process.exit(1);
  });
