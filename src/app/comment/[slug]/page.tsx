import PublicCommentView from './PublicCommentView';

import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  referrer: 'no-referrer',
};

export default async function CommentPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <PublicCommentView slug={slug} />;
}
