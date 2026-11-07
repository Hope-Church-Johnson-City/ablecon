"""Ablecon Remote Script for Ableton Live 11 and 12.

Copy this "Ablecon" folder into Live's User Library under "Remote Scripts",
restart Live, then pick "Ablecon" as a Control Surface in Settings > Link, Tempo & MIDI.
"""
from .surface import AbleconSurface


def create_instance(c_instance):
    return AbleconSurface(c_instance)
