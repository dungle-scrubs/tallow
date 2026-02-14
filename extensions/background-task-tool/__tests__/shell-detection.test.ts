/**
 * Tests for shell command detection patterns in background-task-tool:
 * backgrounding ampersand detection and hang-prone command detection.
 */
import { describe, expect, it } from "bun:test";
import { detectsBackgroundAmpersand, detectsHangPattern } from "../index.js";

// ── detectsBackgroundAmpersand ───────────────────────────────────────────────

describe("detectsBackgroundAmpersand", () => {
	it("detects trailing &", () => {
		expect(detectsBackgroundAmpersand("sleep 10 &")).toBe(true);
	});

	it("detects & followed by semicolon", () => {
		expect(detectsBackgroundAmpersand("cmd &; echo done")).toBe(true);
	});

	it("detects & followed by another command", () => {
		expect(detectsBackgroundAmpersand("cmd & next")).toBe(true);
	});

	it("detects & followed by newline", () => {
		expect(detectsBackgroundAmpersand("cmd &\necho done")).toBe(true);
	});

	it("detects & followed by closing paren", () => {
		expect(detectsBackgroundAmpersand("(cmd &)")).toBe(true);
	});

	it("does NOT detect && (logical AND)", () => {
		expect(detectsBackgroundAmpersand("cmd1 && cmd2")).toBe(false);
	});

	it("does NOT detect &> (redirect)", () => {
		expect(detectsBackgroundAmpersand("cmd &> /dev/null")).toBe(false);
	});

	it("does NOT detect & inside heredocs", () => {
		expect(detectsBackgroundAmpersand("cat <<EOF\ncmd &\nEOF")).toBe(false);
	});

	it("does NOT detect commands without &", () => {
		expect(detectsBackgroundAmpersand("ls -la")).toBe(false);
	});

	it("handles complex command with both && and trailing &", () => {
		expect(detectsBackgroundAmpersand("cmd1 && cmd2 &")).toBe(true);
	});

	it("handles empty string", () => {
		expect(detectsBackgroundAmpersand("")).toBe(false);
	});
});

// ── detectsHangPattern ───────────────────────────────────────────────────────

describe("detectsHangPattern", () => {
	it("detects docker exec with node -e", () => {
		const result = detectsHangPattern("docker exec mycontainer node -e 'console.log(1)'");
		expect(result).not.toBeNull();
		expect(result).toContain("docker exec");
	});

	it("detects docker exec with python -c", () => {
		const result = detectsHangPattern("docker exec mycontainer python -c 'print(1)'");
		expect(result).not.toBeNull();
	});

	it("detects docker exec with -it flag", () => {
		const result = detectsHangPattern("docker exec -it mycontainer bash");
		expect(result).not.toBeNull();
		expect(result).toContain("interactive");
	});

	it("detects docker exec with --interactive flag", () => {
		const result = detectsHangPattern("docker exec --interactive mycontainer sh");
		expect(result).not.toBeNull();
	});

	it("detects tail -f", () => {
		const result = detectsHangPattern("tail -f /var/log/syslog");
		expect(result).not.toBeNull();
		expect(result).toContain("tail -f");
	});

	it("detects watch command", () => {
		const result = detectsHangPattern("watch ls -la");
		expect(result).not.toBeNull();
		expect(result).toContain("watch");
	});

	it("detects nc -l (netcat listen)", () => {
		const result = detectsHangPattern("nc -l 8080");
		expect(result).not.toBeNull();
		expect(result).toContain("netcat");
	});

	it("detects psql with inline query", () => {
		const result = detectsHangPattern("psql -c 'SELECT 1'");
		expect(result).not.toBeNull();
		expect(result).toContain("psql");
	});

	it("detects mysql with inline query", () => {
		const result = detectsHangPattern('mysql -e "SELECT 1"');
		expect(result).not.toBeNull();
		expect(result).toContain("mysql");
	});

	it("returns null for safe commands", () => {
		expect(detectsHangPattern("ls -la")).toBeNull();
		expect(detectsHangPattern("cat file.txt")).toBeNull();
		expect(detectsHangPattern("docker logs mycontainer")).toBeNull();
		expect(detectsHangPattern("npm run build")).toBeNull();
		expect(detectsHangPattern("grep -r pattern .")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(detectsHangPattern("")).toBeNull();
	});

	it("detects piped hang commands only before the pipe", () => {
		// nc -l without pipe should be detected
		expect(detectsHangPattern("nc -l 8080")).not.toBeNull();
		// Commands after pipe are not the concern of hang detection
		expect(detectsHangPattern("echo test | nc -l 8080")).not.toBeNull();
	});
});
