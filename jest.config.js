
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/scripts/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/vendor/', '/dist/'],
}
