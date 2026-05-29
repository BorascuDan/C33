/** @type {import('jest').Config} */
export default {
  testEnvironment: "node",
  // The project is ESM (NodeNext); compile TS tests to ESM via ts-jest.
  extensionsToTreatAsEsm: [".ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  testMatch: ["**/*.test.ts"],
  // Source imports use explicit ".js" specifiers (NodeNext); strip them so
  // Jest resolves the corresponding ".ts" file.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true }],
  },
};
