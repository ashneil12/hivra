// The Prism grammar loaders the async light build uses, keyed by the name a
// code block asks for. @types/react-syntax-highlighter doesn't declare them.
declare module "react-syntax-highlighter/dist/esm/async-languages/prism" {
  const languageLoaders: Record<string, (registerLanguage: (name: string, language: unknown) => void) => Promise<void>>;
  export default languageLoaders;
}
