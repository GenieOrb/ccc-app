import PublicCommentView from './PublicCommentView';

export const dynamic = 'force-dynamic';

export default async function CommentPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <PublicCommentView slug={slug} />;
}
