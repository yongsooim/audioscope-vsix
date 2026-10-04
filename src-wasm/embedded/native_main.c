// Only native builds rename the existing tool entry point to audioscope_main.
#undef main
#include <stdlib.h>
#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>
#include <fcntl.h>
#include <io.h>
#endif

int audioscope_main(int argc, char **argv);

int main(int argc, char **argv) {
#ifdef _WIN32
    int count;
    int index;
    int result;
    wchar_t **wide = CommandLineToArgvW(GetCommandLineW(), &count);
    char **utf8;
    if (wide == NULL) return 1;
    utf8 = calloc((size_t) count + 1, sizeof(*utf8));
    if (utf8 == NULL) {
        LocalFree(wide);
        return 1;
    }
    for (index = 0; index < count; index++) {
        int length = WideCharToMultiByte(CP_UTF8, 0, wide[index], -1, NULL, 0, NULL, NULL);
        utf8[index] = length > 0 ? malloc((size_t) length) : NULL;
        if (utf8[index] == NULL) {
            while (index > 0) free(utf8[--index]);
            free(utf8);
            LocalFree(wide);
            return 1;
        }
        WideCharToMultiByte(CP_UTF8, 0, wide[index], -1, utf8[index], length, NULL, NULL);
    }
    LocalFree(wide);
    _setmode(_fileno(stdout), _O_BINARY);
    result = audioscope_main(count, utf8);
    for (index = 0; index < count; index++) free(utf8[index]);
    free(utf8);
    return result;
#else
    return audioscope_main(argc, argv);
#endif
}
