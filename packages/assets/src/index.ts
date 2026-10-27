// Light asset library: images (SVG included) and PDFs referenced from e-mails and hosted pages. The
// bytes live in Postgres (asset_blobs) so a small install needs no object store; an SVG's PNG
// rendition lives in asset_renditions for e-mail. A driver that keeps them elsewhere would replace
// the blob reads and inserts in commands.ts and routes.ts.
export * from './commands';
export * from './media';
export * from './raster';
export * from './routes';
export * from './svg';
