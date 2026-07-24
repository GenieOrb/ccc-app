import { redirect } from 'next/navigation';
import { isAdminAuthenticated } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const authenticated = await isAdminAuthenticated();
  if (authenticated) {
    redirect('/admin');
  } else {
    redirect('/admin/login');
  }
}
