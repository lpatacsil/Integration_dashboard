import { Router, Request, Response } from 'express';
import {
  getFullSettings, saveSettings,
  type SettingsData,
} from '../services/settings-store';

const router = Router();

/** GET /api/settings — return full settings (SMTP password masked). */
router.get('/', (_req: Request, res: Response) => {
  try {
    const settings = getFullSettings();
    // Mask the SMTP password in the response
    const masked = JSON.parse(JSON.stringify(settings)) as SettingsData;
    if (masked.notificationChannels?.email?.smtp?.password) {
      masked.notificationChannels.email.smtp.password = '********';
    }
    res.json(masked);
  } catch (err: any) {
    console.error('settings GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

/** PUT /api/settings — replace full settings. */
router.put('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as Partial<SettingsData>;
    const updated = await saveSettings(body);
    const masked = JSON.parse(JSON.stringify(updated)) as SettingsData;
    if (masked.notificationChannels?.email?.smtp?.password) {
      masked.notificationChannels.email.smtp.password = '********';
    }
    res.json(masked);
  } catch (err: any) {
    console.error('settings PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

const VALID_SECTIONS = ['contacts', 'categoryRules', 'rules', 'notificationChannels'] as const;
type SectionKey = (typeof VALID_SECTIONS)[number];

/** PATCH /api/settings/:section — update one section. */
router.patch('/:section', async (req: Request, res: Response) => {
  try {
    const section = req.params.section as string;
    if (!VALID_SECTIONS.includes(section as SectionKey)) {
      res.status(400).json({ error: `Invalid section: ${section}. Must be one of: ${VALID_SECTIONS.join(', ')}` });
      return;
    }
    const patch: Partial<SettingsData> = { [section]: req.body };
    const updated = await saveSettings(patch);
    const masked = JSON.parse(JSON.stringify(updated)) as SettingsData;
    if (masked.notificationChannels?.email?.smtp?.password) {
      masked.notificationChannels.email.smtp.password = '********';
    }
    res.json(masked);
  } catch (err: any) {
    console.error('settings PATCH error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
