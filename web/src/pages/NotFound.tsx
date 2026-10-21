import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui';
import { useT } from '../lib/i18n';

export default function NotFound() {
  const t = useT();
  return <EmptyState title={t('errors.notFound')} body={t('errors.notFoundBody')} action={<Link className="btn btn-primary" to="/dashboard">{t('nav.dashboard')}</Link>} />;
}
