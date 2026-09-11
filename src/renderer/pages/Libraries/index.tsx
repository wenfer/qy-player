import ScrapeJobs from './ScrapeJobs';

/**
 * Libraries page shell (QYP2-032): currently hosts the scrape-job
 * monitor; batch launch lives in the catalog browser (LibraryBrowse).
 */
export default function Libraries() {
  return <ScrapeJobs />;
}
