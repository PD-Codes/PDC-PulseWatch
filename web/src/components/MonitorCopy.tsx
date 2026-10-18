import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button, useToast } from './ui';
import { useT } from '../lib/i18n';

/** Small copy-to-clipboard button for snippets on the monitor pages. */
export function MonitorCopy({ text }: { text: string }) {
  const t = useT();
  const toast = useToast();
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { toast(t('common.failed'), 'error'); }
  };
  return <Button size="sm" aria-label={t('common.copy')} onClick={() => void copy()}>{done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}</Button>;
}
