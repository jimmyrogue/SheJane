#include "json.hpp"
#include "whisper.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#ifndef SHEJANE_MODEL_SHA256
#error "SHEJANE_MODEL_SHA256 must be supplied by the locked asset build"
#endif

using json = nlohmann::ordered_json;
namespace fs = std::filesystem;

namespace {

constexpr const char * kVersion = "1.8.6";
constexpr const char * kCommit = "23ee03506a91ac3d3f0071b40e66a430eebdfa1d";
constexpr const char * kModel = "large-v3-turbo";
constexpr const char * kQuantization = "Q5_0";
constexpr int64_t kMaxDurationMs = 7'200'000;
constexpr int kMaxSegments = 20'000;
constexpr int kMaxCharacters = 500'000;

struct WhisperContext {
    whisper_context * value = nullptr;
    ~WhisperContext() {
        if (value != nullptr) {
            whisper_free(value);
        }
    }
};

json read_json(const fs::path & path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) {
        throw std::runtime_error("request is unavailable");
    }
    json value;
    stream >> value;
    return value;
}

uint16_t read_u16(const unsigned char * value) {
    return static_cast<uint16_t>(value[0]) |
        (static_cast<uint16_t>(value[1]) << 8);
}

uint32_t read_u32(const unsigned char * value) {
    return static_cast<uint32_t>(value[0]) |
        (static_cast<uint32_t>(value[1]) << 8) |
        (static_cast<uint32_t>(value[2]) << 16) |
        (static_cast<uint32_t>(value[3]) << 24);
}

std::vector<float> read_normalized_wav(const fs::path & path) {
    std::ifstream stream(path, std::ios::binary);
    const uint64_t file_size = fs::file_size(path);
    std::array<unsigned char, 12> header{};
    if (!stream.read(reinterpret_cast<char *>(header.data()), header.size()) ||
        std::memcmp(header.data(), "RIFF", 4) != 0 ||
        std::memcmp(header.data() + 8, "WAVE", 4) != 0) {
        throw std::runtime_error("normalized WAV header is invalid");
    }
    bool format_seen = false;
    while (stream && static_cast<uint64_t>(stream.tellg()) + 8 <= file_size) {
        std::array<unsigned char, 8> chunk_header{};
        if (!stream.read(reinterpret_cast<char *>(chunk_header.data()), chunk_header.size())) {
            break;
        }
        const uint32_t chunk_size = read_u32(chunk_header.data() + 4);
        const uint64_t chunk_start = static_cast<uint64_t>(stream.tellg());
        if (chunk_start + chunk_size > file_size) {
            throw std::runtime_error("normalized WAV chunk is truncated");
        }
        if (std::memcmp(chunk_header.data(), "fmt ", 4) == 0) {
            if (chunk_size < 16 || chunk_size > 4096) {
                throw std::runtime_error("normalized WAV format is invalid");
            }
            std::vector<unsigned char> format(chunk_size);
            stream.read(reinterpret_cast<char *>(format.data()), format.size());
            if (!stream || read_u16(format.data()) != 1 ||
                read_u16(format.data() + 2) != 1 ||
                read_u32(format.data() + 4) != WHISPER_SAMPLE_RATE ||
                read_u32(format.data() + 8) != WHISPER_SAMPLE_RATE * 2 ||
                read_u16(format.data() + 12) != 2 ||
                read_u16(format.data() + 14) != 16) {
                throw std::runtime_error("normalized WAV format is unsupported");
            }
            format_seen = true;
        } else if (std::memcmp(chunk_header.data(), "data", 4) == 0) {
            if (!format_seen || chunk_size % 2 != 0 ||
                chunk_size > static_cast<uint64_t>(WHISPER_SAMPLE_RATE) * 2 *
                    kMaxDurationMs / 1000) {
                throw std::runtime_error("normalized WAV data is invalid");
            }
            const size_t sample_count = chunk_size / 2;
            std::vector<float> samples(sample_count);
            std::array<unsigned char, 64 * 1024> buffer{};
            size_t converted = 0;
            uint32_t remaining = chunk_size;
            while (remaining > 0) {
                const size_t count = std::min<size_t>(remaining, buffer.size());
                if (!stream.read(reinterpret_cast<char *>(buffer.data()), count)) {
                    throw std::runtime_error("normalized WAV data is truncated");
                }
                for (size_t offset = 0; offset < count; offset += 2) {
                    const uint16_t raw = read_u16(buffer.data() + offset);
                    const int16_t sample = static_cast<int16_t>(raw);
                    samples[converted++] = static_cast<float>(sample) / 32768.0f;
                }
                remaining -= static_cast<uint32_t>(count);
            }
            return samples;
        } else {
            stream.seekg(chunk_size, std::ios::cur);
        }
        if (chunk_size % 2 != 0) {
            stream.seekg(1, std::ios::cur);
        }
    }
    throw std::runtime_error("normalized WAV has no audio data");
}

void write_json(const fs::path & path, const json & value) {
    const fs::path temporary = path.string() + ".tmp";
    {
        std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
        if (!stream) {
            throw std::runtime_error("response is unavailable");
        }
        stream << value.dump();
        stream.flush();
        if (!stream) {
            throw std::runtime_error("response could not be written");
        }
    }
    fs::rename(temporary, path);
}

void require_request(const json & request) {
    if (!request.is_object() || request.value("schema_version", 0) != 1) {
        throw std::runtime_error("request schema is invalid");
    }
    const json expected_configuration = {
        {"best_of", 1},
        {"decoding", "greedy"},
        {"flash_attention", false},
        {"processors", 1},
        {"task", "transcribe"},
        {"temperature", 0},
        {"temperature_fallback", false},
        {"threads", 1},
        {"word_timestamps", false},
    };
    const json expected_limits = {
        {"characters", kMaxCharacters},
        {"duration_ms", kMaxDurationMs},
        {"segments", kMaxSegments},
    };
    if (request.at("configuration") != expected_configuration ||
        request.at("limits") != expected_limits) {
        throw std::runtime_error("request policy is invalid");
    }
    const std::string language = request.at("language").get<std::string>();
    if (language != "auto" && whisper_lang_id(language.c_str()) < 0) {
        throw std::runtime_error("language is unsupported");
    }
    if (request.at("initial_prompt").get<std::string>().size() > 512) {
        throw std::runtime_error("initial prompt is too long");
    }
}

fs::path model_path(const char * executable) {
    return fs::canonical(executable).parent_path().parent_path() / "models" /
        "ggml-large-v3-turbo-q5_0.bin";
}

void quiet_log(enum ggml_log_level, const char *, void *) {}

json transcribe(const json & request, const fs::path & model) {
    const std::string audio_path = request.at("audio_path").get<std::string>();
    std::vector<float> pcm = read_normalized_wav(audio_path);
    const int64_t duration_ms = static_cast<int64_t>(pcm.size()) * 1000 /
        WHISPER_SAMPLE_RATE;
    if (duration_ms < 0 || duration_ms > kMaxDurationMs) {
        throw std::runtime_error("audio duration exceeds the supported limit");
    }

    whisper_context_params context_params = whisper_context_default_params();
    context_params.use_gpu = false;
    context_params.flash_attn = false;
    context_params.dtw_token_timestamps = false;
    WhisperContext context;
    context.value = whisper_init_from_file_with_params(
        model.string().c_str(), context_params
    );
    if (context.value == nullptr) {
        throw std::runtime_error("model could not be loaded");
    }

    std::string language = request.at("language").get<std::string>();
    std::string prompt = request.at("initial_prompt").get<std::string>();
    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.n_threads = 1;
    params.translate = false;
    params.no_timestamps = false;
    params.single_segment = false;
    params.print_special = false;
    params.print_progress = false;
    params.print_realtime = false;
    params.print_timestamps = false;
    params.token_timestamps = false;
    params.tdrz_enable = false;
    params.initial_prompt = prompt.empty() ? nullptr : prompt.c_str();
    params.carry_initial_prompt = false;
    params.language = language == "auto" ? nullptr : language.c_str();
    params.detect_language = false;
    params.temperature = 0.0f;
    params.temperature_inc = 0.0f;
    params.greedy.best_of = 1;
    params.vad = false;
    params.vad_model_path = nullptr;

    if (whisper_full(
            context.value,
            params,
            pcm.data(),
            static_cast<int>(pcm.size())
        ) != 0) {
        throw std::runtime_error("transcription failed");
    }

    const int language_id = whisper_full_lang_id(context.value);
    const char * resolved_language = whisper_lang_str(language_id);
    if (resolved_language == nullptr) {
        throw std::runtime_error("resolved language is unavailable");
    }
    const int segment_count = whisper_full_n_segments(context.value);
    if (segment_count < 0 || segment_count > kMaxSegments) {
        throw std::runtime_error("segment count exceeds the supported limit");
    }
    json segments = json::array();
    int character_count = 0;
    for (int index = 0; index < segment_count; ++index) {
        const char * text = whisper_full_get_segment_text(context.value, index);
        if (text == nullptr) {
            throw std::runtime_error("segment text is unavailable");
        }
        character_count += static_cast<int>(std::string(text).size());
        if (character_count > kMaxCharacters * 4) {
            throw std::runtime_error("transcript exceeds the supported byte limit");
        }
        const int64_t start_ms = std::clamp<int64_t>(
            whisper_full_get_segment_t0(context.value, index) * 10,
            0,
            duration_ms
        );
        const int64_t end_ms = std::clamp<int64_t>(
            whisper_full_get_segment_t1(context.value, index) * 10,
            start_ms,
            duration_ms
        );
        segments.push_back({
            {"start_ms", start_ms},
            {"end_ms", end_ms},
            {"text", text},
        });
    }
    return {
        {"engine", {
            {"name", "whisper.cpp"},
            {"version", kVersion},
            {"commit", kCommit},
            {"model", kModel},
            {"quantization", kQuantization},
            {"model_sha256", SHEJANE_MODEL_SHA256},
            {"provider", "CPU"},
            {"threads", 1},
        }},
        {"duration_ms", duration_ms},
        {"resolved_language", resolved_language},
        {"segments", segments},
    };
}

}  // namespace

int main(int argc, char ** argv) {
    if (argc != 3) {
        std::cerr << "usage: speech-engine request.json response.json\n";
        return 2;
    }
    try {
        whisper_log_set(quiet_log, nullptr);
        const json request = read_json(argv[1]);
        require_request(request);
        write_json(argv[2], transcribe(request, model_path(argv[0])));
        return 0;
    } catch (const std::exception & error) {
        std::cerr << error.what() << "\n";
        return 1;
    }
}
