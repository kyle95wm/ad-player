// Test tool only, not part of the deployed player.
// Renders interleaved float32 PCM through the reference AndroidDSP.h (fixed
// Plezy mode, programme mode off) so tests/compare-dsp.mjs can compare it with
// the JavaScript AudioWorklet port. Build with -I pointing at the reference
// project's src/ directory; that project is only read, never modified.
//
// Usage: render-reference <rate> <channels> <block> <in.f32> <out.f32>
#include "AndroidDSP.h"
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

int main(int argc, char** argv) {
    if (argc != 6) {
        std::cerr << "usage: render-reference rate channels block in.f32 out.f32\n";
        return 1;
    }
    const double rate = std::stod(argv[1]);
    const unsigned channels = std::stoul(argv[2]);
    const unsigned block = std::stoul(argv[3]);
    std::ifstream in(argv[4], std::ios::binary);
    if (!in) return 2;
    std::vector<char> bytes{std::istreambuf_iterator<char>(in), {}};
    if (bytes.size() % (4 * channels) || block == 0) return 2;
    std::vector<float> data(bytes.size() / 4);
    std::memcpy(data.data(), bytes.data(), bytes.size());

    android_normalize::DSP dsp;
    dsp.prepare(rate, channels);
    android_normalize::Settings settings; // defaults = fixed Plezy values, programme off
    std::vector<std::vector<float>> inBuf(channels, std::vector<float>(block)), outBuf = inBuf;
    const float* ip[8]{};
    float* op[8]{};
    for (unsigned c = 0; c < channels; ++c) { ip[c] = inBuf[c].data(); op[c] = outBuf[c].data(); }

    const size_t frames = data.size() / channels;
    for (size_t start = 0; start < frames; start += block) {
        const unsigned count = unsigned(std::min<size_t>(block, frames - start));
        for (unsigned c = 0; c < channels; ++c)
            for (unsigned n = 0; n < count; ++n) inBuf[c][n] = data[(start + n) * channels + c];
        dsp.process(ip, op, count, settings);
        for (unsigned c = 0; c < channels; ++c)
            for (unsigned n = 0; n < count; ++n) data[(start + n) * channels + c] = outBuf[c][n];
    }
    std::ofstream out(argv[5], std::ios::binary);
    out.write(reinterpret_cast<const char*>(data.data()), data.size() * 4);
    std::cout << dsp.latencySamples() << "\n";
    return out ? 0 : 3;
}
