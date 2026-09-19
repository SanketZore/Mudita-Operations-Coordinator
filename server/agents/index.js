import { intake } from './intake.js';
import { planning } from './planning.js';
import { review } from './review.js';

export const agents = { intake, planning, review };
export const AGENT_ORDER = ['intake', 'planning', 'review'];
