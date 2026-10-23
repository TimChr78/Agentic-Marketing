import { useEffect } from 'react';
import { LiveWorkspace } from './screens/LiveWorkspace';

// Production entry for the image: only the real workspace (REST API), without the Phase −1
// demo navigation, mock store or ambient traffic.
export default function LiveApp() {
  useEffect(() => {
    document.title = 'Agentic Marketing';
  }, []);

  return (
    <div className="min-h-screen bg-bg px-4 py-6 lg:px-8">
      <LiveWorkspace />
    </div>
  );
}
