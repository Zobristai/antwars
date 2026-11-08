import { it } from 'vitest';
import { checkPointCapacity } from './point-capacity.js';
it('4096 organic-cluster ants settle on central-lake', () => checkPointCapacity('central-lake'), 240000);
