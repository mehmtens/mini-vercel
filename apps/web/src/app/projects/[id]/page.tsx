import { STATIC_ROUTE_ID } from '../../../lib/route-id';
import ProjectDetailView from './view';

export function generateStaticParams() {
  return [{ id: STATIC_ROUTE_ID }];
}

export default function ProjectDetailPage() {
  return <ProjectDetailView />;
}
