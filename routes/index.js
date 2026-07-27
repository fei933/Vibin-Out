import express from 'express';
import { DISCOVERY_MODES, DURATIONS, MAX_INPUT_LENGTH } from '../lib/validation.js';

const router = express.Router();

const EXAMPLES = [
  { label: 'Smoky oud', value: 'smoky oud, charred cedar, a little leather' },
  { label: 'Espresso beans', value: 'espresso beans, dark chocolate, warm milk' },
  { label: 'Ocean soap', value: 'ocean soap, cold salt air, clean cotton' },
];

router.get('/', (req, res) => {
  res.render('home', {
    isHome: true,
    maxLength: MAX_INPUT_LENGTH,
    durations: DURATIONS.map((minutes) => ({
      value: minutes,
      label: `${minutes} min`,
      checked: minutes === 60,
    })),
    discoveries: [
      { value: DISCOVERY_MODES[0], label: 'Familiar' },
      { value: DISCOVERY_MODES[1], label: 'Balanced', checked: true },
      { value: DISCOVERY_MODES[2], label: 'Deep cuts' },
    ],
    examples: EXAMPLES,
  });
});

export default router;
