/* Runs a script of calls against the native engine: probe <pack.json> <calls.tsv>.
   Each line of calls.tsv is the call's name, a tab, and its request as JSON; each result is
   printed on its own line, in order, with the call's time on stderr. A line without a tab is
   refused (exit 2), and a panic prints its message and exits 3. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

extern void dm_init(void);
extern void dm_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern double dm_load(const uint8_t *id, size_t id_len, const uint8_t *pack, size_t pack_len);
extern void dm_call(double handle, const uint8_t *op, size_t op_len, const uint8_t *req, size_t req_len, const uint8_t **out, size_t *out_len);

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx; (void)addr;
  fprintf(stderr, "panic: %.*s\n", (int)len, msg);
  exit(3);
}

static char *slurp(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (!f) { perror(path); exit(2); }
  fseek(f, 0, SEEK_END); *len = (size_t)ftell(f); rewind(f);
  char *buf = malloc(*len + 1);
  if (fread(buf, 1, *len, f) != *len) { perror(path); exit(2); }
  buf[*len] = 0; fclose(f);
  return buf;
}

int main(int argc, char **argv) {
  if (argc != 3) { fprintf(stderr, "usage: probe <pack.json> <calls.tsv>\n"); return 2; }
  dm_set_panic_sink(sink, NULL);
  dm_init();
  size_t pack_len, calls_len;
  char *pack = slurp(argv[1], &pack_len), *calls = slurp(argv[2], &calls_len);
  double h = dm_load((const uint8_t *)"area", 4, (const uint8_t *)pack, pack_len);
  for (char *line = strtok(calls, "\n"); line; line = strtok(NULL, "\n")) {
    char *tab = strchr(line, '\t');
    if (!tab || tab == line) { fprintf(stderr, "not a call (name, tab, request): %.80s\n", line); return 2; }
    char *op = line, *req = tab + 1;
    size_t op_len = (size_t)(tab - line), req_len = strlen(req);
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    const uint8_t *out; size_t out_len;
    dm_call(h, (const uint8_t *)op, op_len, (const uint8_t *)req, req_len, &out, &out_len);
    clock_gettime(CLOCK_MONOTONIC, &t1);
    fwrite(out, 1, out_len, stdout); fputc('\n', stdout);
    fprintf(stderr, "%.*s %.0f ms\n", (int)op_len, op, (t1.tv_sec - t0.tv_sec) * 1e3 + (t1.tv_nsec - t0.tv_nsec) / 1e6);
  }
  return 0;
}
