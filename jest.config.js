module.exports = {
	testEnvironment: "node",
	testMatch: ["**/__tests__/**/*.spec.ts"],
	moduleFileExtensions: ["ts", "js", "json"],
	transform: {
		"^.+\\.ts$": [
			"ts-jest",
			{
				tsconfig: "tsconfig.test.json",
			},
		],
	},
}
