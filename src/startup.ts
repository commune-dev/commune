import metricsScheduler from './services/metricsScheduler';
import logger from './utils/logger';

// Initialize monitoring system on server startup
const initializeMonitoring = (): void => {
  logger.info('Initializing monitoring system');

  // Start the metrics cache scheduler
  metricsScheduler.startMetricsScheduler();

  logger.info('Monitoring system initialized successfully');
};

export default {
  initializeMonitoring
};
