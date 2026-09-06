import { STATIC_ROUTE_ID } from '../../../lib/route-id';
import DeploymentDetailView from './view';

export function generateStaticParams() {
  return [{ id: STATIC_ROUTE_ID }];
}

export default function DeploymentDetailPage() {
  return <DeploymentDetailView />;
}
