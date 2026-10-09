// The features' styles load with the app's, in their place before styles.css, though the features'
// code loads only when needed (loadFeatures in lib/router.ts): the home page shows some of their parts
// (app chips, the seat picker), and their rules were written for this order.
import.meta.glob('./**/*.css', { eager: true });
