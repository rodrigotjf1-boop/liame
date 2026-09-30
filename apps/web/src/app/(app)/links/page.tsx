import type { Metadata } from 'next';
import { LinksTela } from '@/components/links/links-tela';

export const metadata: Metadata = { title: 'Links e cupons · Liame' };

export default function LinksPage() {
  return <LinksTela />;
}
