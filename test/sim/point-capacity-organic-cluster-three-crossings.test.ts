import { it } from 'vitest';
import { checkPointCapacity } from './point-capacity.js';
it('4096 organic-cluster ants settle on three-crossings', () => checkPointCapacity('three-crossings'), 240000);
