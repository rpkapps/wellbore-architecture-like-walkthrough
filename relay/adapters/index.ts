import type { RelayAdapter } from '../adapter';
import { etpAdapter } from './etp';
import { fileAdapter } from './file';
import { httpAdapter } from './http';
import { kafkaAdapter } from './kafka';
import { mqttAdapter } from './mqtt';
import { osduAdapter } from './osdu';
import { tcpAdapter } from './tcp';
import { witsmlAdapter } from './witsml';

export const ADAPTERS: RelayAdapter<any, any>[] = [kafkaAdapter, witsmlAdapter, etpAdapter, osduAdapter, tcpAdapter, mqttAdapter, httpAdapter, fileAdapter]; // eslint-disable-line @typescript-eslint/no-explicit-any
