import { useEffect } from 'react';
import { CSS } from '../../lib/v6-css';
import { PHONE_HTML } from '../../lib/v6-html';
import { initV6Dashboard, teardownV6Dashboard } from '../../lib/v6-logic';

export default function DashboardTokenPage() {
  useEffect(() => {
    initV6Dashboard();
    return teardownV6Dashboard;
  }, []);

  return (
    <>
      <style jsx global>{CSS}</style>
      <div dangerouslySetInnerHTML={{ __html: PHONE_HTML }} />
    </>
  );
}
