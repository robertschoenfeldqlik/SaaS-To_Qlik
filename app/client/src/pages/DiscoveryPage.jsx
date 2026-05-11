import { useState } from 'react';
import SourceTypePicker from '../components/discovery/SourceTypePicker';
import ApiSourceWizard from '../components/discovery/ApiSourceWizard';
import DatabaseSourceWizard from '../components/discovery/DatabaseSourceWizard';
import DbtSourceWizard from '../components/discovery/DbtSourceWizard';
import NonProdWarningBanner from '../components/shared/NonProdWarningBanner';
import { ArrowLeft } from 'lucide-react';

export default function DiscoveryPage() {
  const [sourceType, setSourceType] = useState(null);

  const title =
    sourceType === 'dbt'
      ? 'Convert dbt Project to Talend'
      : sourceType === 'database'
        ? 'Discover Database'
        : sourceType === 'api'
          ? 'Discover API'
          : 'Choose Source Type';

  const subtitle =
    sourceType === 'dbt'
      ? 'Upload a dbt project, select models, and emit Talend jobs that run the compiled SQL'
      : sourceType === 'database'
        ? 'Connect to a database, scan the schema, and generate Talend jobs per table'
        : sourceType === 'api'
          ? 'Provide an OpenAPI specification to discover endpoints and generate Talend jobs'
          : 'Select what kind of data source you want to integrate';

  return (
    <div className="p-8 max-w-5xl mx-auto animate-fade-in-up">
      <NonProdWarningBanner />

      <div className="mb-6 flex items-center gap-3">
        {sourceType && (
          <button onClick={() => setSourceType(null)} className="btn-ghost flex items-center gap-1.5 text-sm">
            <ArrowLeft className="w-4 h-4" /> Change source
          </button>
        )}
        <div>
          <h1 className="page-header">{title}</h1>
          <p className="page-subtitle">{subtitle}</p>
        </div>
      </div>
      {sourceType === null && <SourceTypePicker onSelect={setSourceType} />}
      {sourceType === 'api' && <ApiSourceWizard />}
      {sourceType === 'database' && <DatabaseSourceWizard />}
      {sourceType === 'dbt' && <DbtSourceWizard />}
    </div>
  );
}
