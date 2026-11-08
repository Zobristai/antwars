import { it } from 'vitest';
import { checkPointCapacity } from './point-capacity.js';
it('4096 organic-cluster ants settle on open-field', () => checkPointCapacity('open-field'), 240000);
